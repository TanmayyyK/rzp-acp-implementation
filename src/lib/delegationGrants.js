'use strict';

/**
 * Delegation grants: the durable, human-signed authority an agent acts under.
 *
 * A grant is an IntentMandate whose proof is a WebAuthn assertion from the
 * human's authenticator. The agent never holds a signing key; it holds a
 * *reference* to a grant. Everything an agent is allowed to do is therefore
 * bounded by something a human physically signed, and revocable by the human at
 * any time.
 *
 * The grant id is not a secret. Authority comes from the human's signature and
 * the grant's own limits (cap, expiry, revocation), all re-checked on every use
 * here — not from the id being unguessable.
 *
 * Lifecycle owner: persistence and validity live here; the cryptographic check
 * lives in src/circle/humanAuthorization.js; the spend decision lives in
 * src/lib/delegation.js.
 */

const db = require('../db');
const humanAuth = require('../circle/humanAuthorization');

/** Persist a grant whose assertion has already been verified. */
function issueGrant({ envelope, principalId, agentId, maxAmountPaise, challenge, credentialId }) {
  db.prepare(
    `INSERT INTO delegation_grants
       (mandate_id, principal_id, agent_id, mandate_json, max_amount_paise,
        challenge, credential_id, status, issued_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`
  ).run(
    envelope.mandate_id,
    principalId,
    agentId,
    JSON.stringify(envelope),
    maxAmountPaise,
    challenge,
    credentialId,
    envelope.issued_at,
    envelope.expires_at
  );
  return loadGrant(envelope.mandate_id);
}

function loadGrant(mandateId) {
  if (typeof mandateId !== 'string' || mandateId.length === 0) return null;
  return db.prepare('SELECT * FROM delegation_grants WHERE mandate_id = ?').get(mandateId) || null;
}

/**
 * Resolve a grant for use, re-checking every condition that bounds it.
 *
 * Called at cart creation *and* again at completion, so a human who revokes
 * mid-flight stops a checkout that is already in progress. Checking only at
 * issuance would make the kill switch decorative.
 *
 * @returns {{ok: true, grant: object, envelope: object} | {ok: false, reason: string, detail?: string}}
 */
function resolveActiveGrant(mandateId, now = new Date()) {
  const grant = loadGrant(mandateId);
  if (!grant) return { ok: false, reason: 'GRANT_NOT_FOUND' };
  if (grant.status !== 'active') return { ok: false, reason: 'GRANT_REVOKED' };
  if (new Date(grant.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'GRANT_EXPIRED', detail: `expired at ${grant.expires_at}` };
  }

  let envelope;
  try {
    envelope = JSON.parse(grant.mandate_json);
  } catch {
    return { ok: false, reason: 'GRANT_CORRUPT' };
  }

  const proof = envelope.proof;
  if (!proof || proof.type !== 'webauthn-assertion' || !proof.response) {
    return { ok: false, reason: 'GRANT_PROOF_NOT_WEBAUTHN' };
  }

  // The stored envelope must still hash to the challenge the human's
  // authenticator signed. Catches any drift between the bytes we persisted and
  // the bytes that were authorized.
  const { proof: _omit, ...payload } = envelope;
  const binding = humanAuth.verifyPayloadBinding(payload, proof.response);
  if (!binding.verified) return { ok: false, reason: 'GRANT_BINDING_INVALID', detail: binding.reason };
  if (humanAuth.assertionChallenge(proof.response) !== grant.challenge) {
    return { ok: false, reason: 'GRANT_BINDING_INVALID', detail: 'stored challenge does not match assertion' };
  }

  return { ok: true, grant, envelope };
}

/**
 * The grant an agent should act under for a principal: newest active, unexpired.
 *
 * The agent runs in-process and reads this directly rather than being handed a
 * token, because a token would just be a second, weaker copy of the authority
 * the grant already carries.
 */
function activeGrantFor(principalId, now = new Date()) {
  const rows = db
    .prepare(
      `SELECT * FROM delegation_grants
        WHERE principal_id = ? AND status = 'active'
        ORDER BY issued_at DESC`
    )
    .all(principalId);
  return rows.find((r) => new Date(r.expires_at).getTime() > now.getTime()) || null;
}

function listGrants(principalId) {
  return db
    .prepare(
      `SELECT mandate_id, principal_id, agent_id, max_amount_paise, status,
              issued_at, expires_at, revoked_at
         FROM delegation_grants WHERE principal_id = ? ORDER BY issued_at DESC`
    )
    .all(principalId);
}

/**
 * The human's kill switch. Scoped to the principal so one user cannot revoke
 * another's delegation.
 */
function revokeGrant(mandateId, principalId) {
  const grant = loadGrant(mandateId);
  if (!grant) return { ok: false, reason: 'GRANT_NOT_FOUND' };
  if (grant.principal_id !== principalId) return { ok: false, reason: 'PRINCIPAL_MISMATCH' };
  if (grant.status !== 'active') return { ok: true, grant, alreadyRevoked: true };

  const revokedAt = new Date().toISOString();
  db.prepare("UPDATE delegation_grants SET status = 'revoked', revoked_at = ? WHERE mandate_id = ?")
    .run(revokedAt, mandateId);
  return { ok: true, grant: loadGrant(mandateId), alreadyRevoked: false };
}

module.exports = {
  issueGrant,
  loadGrant,
  resolveActiveGrant,
  activeGrantFor,
  listGrants,
  revokeGrant,
};
