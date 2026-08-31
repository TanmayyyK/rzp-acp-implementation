'use strict';

/**
 * Human authorization boundary.
 *
 * Every place money can move asks exactly one question: *did the human's
 * authenticator sign this specific payload?* This module is the only thing that
 * answers it, so there is one implementation of the check and one place to audit.
 *
 * The server holds no human signing key. It cannot produce a human signature,
 * only recognize one, which is what makes "the human approved this" a fact
 * rather than a server-side assertion. Concretely: a challenge is the SHA-256 of
 * the JCS-canonical payload being authorized, so an assertion is inseparable
 * from the exact bytes it covers — swap a field and the derived challenge no
 * longer matches what the authenticator signed.
 */

const crypto = require('crypto');
const db = require('../db');
const webauthn = require('./webauthn');

/** Load the human's registered authenticator, in the shape verifyAuthResponse wants. */
function getCredential(principalId) {
  const row = db.prepare('SELECT * FROM webauthn_credentials WHERE principal_id = ?').get(principalId);
  if (!row) return null;
  return {
    credentialID: row.credential_id,
    credentialPublicKey: row.public_key,
    counter: row.counter,
    transports: row.transports ? JSON.parse(row.transports) : undefined,
  };
}

/**
 * The challenge the authenticator actually signed, read back out of the
 * assertion's clientDataJSON.
 *
 * Used for binding checks on stored assertions. The signature covers
 * clientDataJSON, so this value cannot be edited without invalidating it.
 */
function assertionChallenge(assertion) {
  try {
    const raw = Buffer.from(assertion.response.clientDataJSON, 'base64url').toString('utf8');
    const challenge = JSON.parse(raw).challenge;
    return typeof challenge === 'string' ? challenge : null;
  } catch {
    return null;
  }
}

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a human WebAuthn assertion over `boundPayload`.
 *
 * On success the stored signature counter is advanced, so the same assertion
 * cannot be replayed. That makes an assertion single-use: callers that need to
 * re-check a *stored* assertion later must use verifyPayloadBinding instead.
 *
 * Never throws for an authorization failure — a bad assertion is an expected
 * outcome, not an exception. Returns { verified, reason }.
 *
 * @param {object}  args
 * @param {string}  args.principalId
 * @param {object}  args.boundPayload  Exact object the human is authorizing.
 * @param {object}  args.assertion     AuthenticationResponseJSON from the client.
 */
async function verifyHumanAssertion({ principalId, boundPayload, assertion }) {
  if (!principalId) return { verified: false, reason: 'MISSING_PRINCIPAL' };
  if (!assertion || typeof assertion !== 'object' || !assertion.response) {
    return { verified: false, reason: 'MALFORMED_ASSERTION' };
  }

  const credential = getCredential(principalId);
  if (!credential) return { verified: false, reason: 'NO_REGISTERED_CREDENTIAL' };

  const expectedChallenge = webauthn.generateTransactionChallenge(boundPayload);

  let result;
  try {
    result = await webauthn.verifyAuthResponse(assertion, expectedChallenge, credential);
  } catch (err) {
    // Challenge/origin/RPID/counter mismatches surface as thrown errors here.
    return { verified: false, reason: 'ASSERTION_REJECTED', detail: err.message };
  }

  if (!result.verified) return { verified: false, reason: 'ASSERTION_REJECTED' };

  db.prepare('UPDATE webauthn_credentials SET counter = ? WHERE principal_id = ?')
    .run(result.newCounter, principalId);

  return { verified: true, reason: null, credentialId: credential.credentialID, newCounter: result.newCounter };
}

/**
 * Check that a stored assertion is bound to `boundPayload`, without consuming a
 * counter step.
 *
 * The full ceremony (signature + counter + origin) runs once, at issuance, when
 * the counter is fresh. Re-running it on every later use would fail by design,
 * because issuance already advanced the counter. What still matters on each use
 * is that the payload has not drifted from what was signed — the challenge is a
 * collision-resistant hash of that payload and is covered by the signature, so
 * comparing it detects any drift.
 */
function verifyPayloadBinding(boundPayload, assertion) {
  const signed = assertionChallenge(assertion);
  if (!signed) return { verified: false, reason: 'MALFORMED_ASSERTION' };
  const expected = webauthn.generateTransactionChallenge(boundPayload);
  if (!safeEqual(signed, expected)) return { verified: false, reason: 'PAYLOAD_BINDING_MISMATCH' };
  return { verified: true, reason: null };
}

/**
 * The exact fields of an ApprovalMandate the human signs.
 *
 * Deriving the challenge from these — rather than from the cart alone — is what
 * puts the amount, the session, and the cart under the human's signature. An
 * approval for one session or a lower amount cannot be lifted onto another.
 */
function approvalBinding(mandate) {
  return {
    type: 'ApprovalMandate',
    session_id: mandate.session_id,
    principal_id: mandate.principal_id,
    cart_mandate_id: mandate.cart_mandate_id === undefined ? null : mandate.cart_mandate_id,
    approved_amount: mandate.approved_amount,
    issued_at: mandate.issued_at,
  };
}

/**
 * Build the unsigned ApprovalMandate the human is asked to authorize, plus the
 * challenge derived from it. The server chooses every field so the client cannot
 * quietly widen the approval; the client's only job is to get it signed.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} args.principalId
 * @param {string|null} args.cartMandateId
 * @param {number} args.amountPaise
 */
function buildApprovalRequest({ sessionId, principalId, cartMandateId, amountPaise }) {
  const core = {
    type: 'ApprovalMandate',
    session_id: sessionId,
    principal_id: principalId,
    cart_mandate_id: cartMandateId === undefined ? null : cartMandateId,
    approved_amount: amountPaise,
    issued_at: new Date().toISOString(),
  };
  return { core, challenge: webauthn.generateTransactionChallenge(approvalBinding(core)) };
}

/**
 * Verify a per-transaction ApprovalMandate.
 *
 * Two independent things have to hold, and both are checked here:
 *   1. The human's authenticator signed this mandate's own fields.
 *   2. Those signed fields actually match the transaction being authorized.
 *
 * (1) alone would let a valid approval be replayed against a different session
 * or a larger amount; (2) alone is just the server trusting the client's claim.
 *
 * @param {object} args
 * @param {object} args.approvalMandate
 * @param {string} args.principalId    Principal the transaction runs as.
 * @param {string} args.sessionId      Session being completed.
 * @param {string|null} args.cartMandateId
 * @param {number} args.amountPaise    Amount about to be charged.
 */
async function verifyApprovalMandate({ approvalMandate, principalId, sessionId, cartMandateId, amountPaise }) {
  if (!approvalMandate || typeof approvalMandate !== 'object') {
    return { verified: false, reason: 'NO_APPROVAL_MANDATE' };
  }
  if (approvalMandate.type !== 'ApprovalMandate') {
    return { verified: false, reason: 'NOT_AN_APPROVAL_MANDATE' };
  }
  const proof = approvalMandate.proof;
  if (!proof || proof.type !== 'webauthn-assertion' || !proof.response) {
    // An EdDSA proof here would mean some in-process key signed the approval.
    // Only a human authenticator can approve, so this shape is rejected outright.
    return { verified: false, reason: 'APPROVAL_PROOF_NOT_WEBAUTHN' };
  }

  // Signed fields must describe *this* transaction.
  if (!safeEqual(String(approvalMandate.principal_id || ''), String(principalId || ''))) {
    return { verified: false, reason: 'APPROVAL_PRINCIPAL_MISMATCH' };
  }
  if (!safeEqual(String(approvalMandate.session_id || ''), String(sessionId || ''))) {
    return { verified: false, reason: 'APPROVAL_SESSION_MISMATCH' };
  }
  const boundCart = approvalMandate.cart_mandate_id === undefined ? null : approvalMandate.cart_mandate_id;
  const expectedCart = cartMandateId === undefined ? null : cartMandateId;
  if (boundCart !== expectedCart) {
    return { verified: false, reason: 'APPROVAL_CART_MISMATCH' };
  }
  if (!Number.isInteger(approvalMandate.approved_amount) || approvalMandate.approved_amount < amountPaise) {
    return { verified: false, reason: 'APPROVAL_AMOUNT_INSUFFICIENT' };
  }

  return verifyHumanAssertion({
    principalId,
    boundPayload: approvalBinding(approvalMandate),
    assertion: proof.response,
  });
}

module.exports = {
  getCredential,
  assertionChallenge,
  verifyHumanAssertion,
  verifyPayloadBinding,
  approvalBinding,
  buildApprovalRequest,
  verifyApprovalMandate,
};
