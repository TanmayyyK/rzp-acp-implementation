'use strict';

/**
 * Delegation grant ceremony — where an agent's authority actually comes from.
 *
 * The human authenticates, sees what they are about to authorize, and signs the
 * IntentMandate with their own authenticator. The server never signs on their
 * behalf; it builds the envelope, hands over a challenge derived from it, and
 * either recognizes a valid assertion or refuses.
 *
 * Two ceilings apply, and the tighter one wins:
 *   - what the human asked for in this grant, and
 *   - `users.budget_cap_paise`, the account-level cap.
 * A request can only ever *lower* the effective cap. That matters because a
 * compromised page can choose what to put in front of the authenticator — the
 * authenticator shows an opaque challenge, not the amount — so the account cap
 * is the backstop that a bad page cannot talk its way past.
 */

const express = require('express');
const crypto = require('crypto');

const db = require('../db');
const config = require('../config');
const webauthn = require('../circle/webauthn');
const humanAuth = require('../circle/humanAuthorization');
const grants = require('../lib/delegationGrants');
const { validateIntentMandate } = require('../../schemas/validate');
const { sharedAuditLog, EventType, Actor } = require('../lib/auditLog');

const router = express.Router();

const DEFAULT_CAP_PAISE = 1000000;

/** Require an authenticated human. Grants may only be created by a person. */
function requireHuman(req, res, next) {
  if (!req.session || !req.session.authenticated || !req.session.principal_id) {
    return res.status(401).json({
      error: { code: 'HUMAN_SESSION_REQUIRED', message: 'A WebAuthn-authenticated human session is required', retriable: false },
    });
  }
  return next();
}

function accountCapPaise(principalId) {
  const row = db.prepare('SELECT budget_cap_paise FROM users WHERE principal_id = ?').get(principalId);
  return row && Number.isInteger(row.budget_cap_paise) ? row.budget_cap_paise : DEFAULT_CAP_PAISE;
}

/** The storefront's real categories, so the allowlist is not a second source of truth. */
function storefrontCategories() {
  return db
    .prepare('SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category')
    .all()
    .map((r) => r.category);
}

/**
 * Build the IntentMandate the human is about to sign.
 *
 * Every field is chosen server-side. The client supplies preferences, not
 * content, so there is nothing for it to smuggle into the envelope.
 */
function buildIntentEnvelope({ principalId, agentId, maxAmountPaise, naturalLanguageIntent, categories, ttlMs }) {
  const issuedAt = new Date();
  return {
    mandate_id: `man_int_${crypto.randomBytes(8).toString('hex')}`,
    type: 'IntentMandate',
    spec: 'ap2/0.1',
    prev_mandate_id: null,
    session_id: null,
    // The authority root is a WebAuthn credential held by this human.
    issuer: `did:webauthn:${principalId}`,
    subject: principalId,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'),
    claims: {
      natural_language_intent: naturalLanguageIntent,
      constraints: {
        max_amount: maxAmountPaise,
        currency: 'INR',
        categories_allowed: categories,
      },
      principal: principalId,
      agent: agentId,
    },
  };
}

function resolveRequestedCap(body, principalId) {
  const cap = accountCapPaise(principalId);
  const raw = body.max_amount_paise !== undefined
    ? body.max_amount_paise
    : body.max_amount_rupees !== undefined
      ? Math.round(Number(body.max_amount_rupees) * 100)
      : cap;

  if (!Number.isInteger(raw) || raw <= 0) {
    return { error: 'max_amount must be a positive integer amount' };
  }
  // A request can lower the ceiling, never raise it.
  return { maxAmountPaise: Math.min(raw, cap), accountCapPaise: cap };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. REQUEST A GRANT CHALLENGE
//    POST /api/v1/mandates/intent/challenge
// ═══════════════════════════════════════════════════════════════════════

router.post('/intent/challenge', requireHuman, async (req, res) => {
  try {
    const principalId = req.session.principal_id;
    const body = req.body || {};

    const credential = humanAuth.getCredential(principalId);
    if (!credential) {
      return res.status(404).json({
        error: { code: 'NO_REGISTERED_CREDENTIAL', message: 'Register a passkey before delegating authority', retriable: false },
      });
    }

    const cap = resolveRequestedCap(body, principalId);
    if (cap.error) {
      return res.status(400).json({ error: { code: 'INVALID_CAP', message: cap.error, retriable: false } });
    }

    const allCategories = storefrontCategories();
    const requested = Array.isArray(body.categories_allowed) ? body.categories_allowed : null;
    // Same rule as the cap: the request may narrow the allowlist, not widen it.
    const categories = requested ? allCategories.filter((c) => requested.includes(c)) : allCategories;
    if (categories.length === 0) {
      return res.status(400).json({
        error: { code: 'INVALID_CATEGORIES', message: 'categories_allowed matched no storefront category', retriable: false },
      });
    }

    const ttlMs = Number.isInteger(body.ttl_ms) && body.ttl_ms > 0
      ? Math.min(body.ttl_ms, config.delegationGrantTtlMs)
      : config.delegationGrantTtlMs;

    const envelope = buildIntentEnvelope({
      principalId,
      agentId: typeof body.agent_id === 'string' && body.agent_id ? body.agent_id : config.agentId,
      maxAmountPaise: cap.maxAmountPaise,
      naturalLanguageIntent: typeof body.natural_language_intent === 'string' && body.natural_language_intent
        ? body.natural_language_intent
        : `Delegate up to ${cap.maxAmountPaise} paise of autonomous spending`,
      categories,
      ttlMs,
    });

    const challenge = webauthn.generateTransactionChallenge(envelope);
    const options = await webauthn.generateAuthOptions(
      {
        id: principalId,
        username: principalId,
        credentials: [{ id: credential.credentialID, transports: credential.transports }],
      },
      challenge
    );

    // The envelope is returned, not stashed. It is inert until signed, and the
    // signature is what binds it — so there is no pending-state to keep or leak.
    return res.status(200).json({
      intent_mandate: envelope,
      account_cap_paise: cap.accountCapPaise,
      webauthn: options,
    });
  } catch (err) {
    console.error('[Mandates] intent challenge error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to build grant challenge', retriable: true } });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. ISSUE THE GRANT
//    POST /api/v1/mandates/intent
// ═══════════════════════════════════════════════════════════════════════

router.post('/intent', requireHuman, async (req, res) => {
  try {
    const principalId = req.session.principal_id;
    const { intent_mandate, assertion } = req.body || {};

    if (!intent_mandate || typeof intent_mandate !== 'object') {
      return res.status(400).json({ error: { code: 'MANDATE_MISSING', message: 'intent_mandate is required', retriable: false } });
    }
    if (!assertion || typeof assertion !== 'object') {
      return res.status(400).json({ error: { code: 'ASSERTION_MISSING', message: 'assertion is required', retriable: false } });
    }

    // Re-derive the challenge from the envelope as submitted. Any edit since the
    // challenge was issued changes this hash, so the assertion stops verifying.
    const { proof: _discard, ...envelope } = intent_mandate;

    // The envelope must describe *this* human and stay inside the account cap,
    // checked here rather than trusted from the challenge step.
    if (envelope.subject !== principalId || !envelope.claims || envelope.claims.principal !== principalId) {
      return res.status(403).json({
        error: { code: 'PRINCIPAL_MISMATCH', message: 'intent_mandate principal does not match the authenticated human', retriable: false },
      });
    }
    const cap = accountCapPaise(principalId);
    const maxAmount = envelope.claims.constraints && envelope.claims.constraints.max_amount;
    if (!Number.isInteger(maxAmount) || maxAmount <= 0 || maxAmount > cap) {
      return res.status(403).json({
        error: { code: 'CAP_EXCEEDED', message: `Grant cap must be a positive integer no greater than the account cap (${cap} paise)`, retriable: false },
      });
    }
    if (grants.loadGrant(envelope.mandate_id)) {
      return res.status(409).json({ error: { code: 'GRANT_EXISTS', message: 'A grant with this mandate_id already exists', retriable: false } });
    }

    const verification = await humanAuth.verifyHumanAssertion({
      principalId,
      boundPayload: envelope,
      assertion,
    });
    if (!verification.verified) {
      sharedAuditLog.append({
        session_id: null,
        actor: Actor.GUARDRAIL,
        event_type: EventType.GUARDRAIL_DECISION,
        payload: {
          check: 'delegation_grant_signature',
          outcome: 'BLOCK',
          detail: verification.reason,
          principal_id: principalId,
        },
      });
      return res.status(401).json({
        error: { code: 'HUMAN_SIGNATURE_INVALID', message: `Grant not authorized by the human: ${verification.reason}`, retriable: false },
      });
    }

    const signedEnvelope = {
      ...envelope,
      proof: { type: 'webauthn-assertion', response: assertion },
    };

    // Self-check the envelope we are about to treat as authority.
    const shapeCheck = validateIntentMandate(signedEnvelope);
    if (!shapeCheck.valid) {
      return res.status(400).json({
        error: { code: 'INTENT_MANDATE_INVALID', message: shapeCheck.errors.join('; '), retriable: false },
      });
    }

    const grant = grants.issueGrant({
      envelope: signedEnvelope,
      principalId,
      agentId: signedEnvelope.claims.agent,
      maxAmountPaise: maxAmount,
      challenge: webauthn.generateTransactionChallenge(envelope),
      credentialId: verification.credentialId,
    });

    sharedAuditLog.append({
      session_id: null,
      actor: Actor.HUMAN,
      event_type: EventType.MANDATE_ISSUED,
      payload: {
        note: 'DELEGATION_GRANT_ISSUED',
        mandate: signedEnvelope,
        principal_id: principalId,
        agent_id: grant.agent_id,
        max_paise: maxAmount,
        authorized_by: 'webauthn-assertion',
        credential_id: verification.credentialId,
      },
    });

    return res.status(201).json({
      mandate_id: grant.mandate_id,
      principal_id: grant.principal_id,
      agent_id: grant.agent_id,
      max_amount_paise: grant.max_amount_paise,
      status: grant.status,
      issued_at: grant.issued_at,
      expires_at: grant.expires_at,
    });
  } catch (err) {
    console.error('[Mandates] issue grant error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to issue delegation grant', retriable: true } });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 3. LIST GRANTS
//    GET /api/v1/mandates/intent
// ═══════════════════════════════════════════════════════════════════════

router.get('/intent', requireHuman, (req, res) => {
  const principalId = req.session.principal_id;
  const active = grants.activeGrantFor(principalId);
  return res.json({
    principal_id: principalId,
    account_cap_paise: accountCapPaise(principalId),
    active_mandate_id: active ? active.mandate_id : null,
    grants: grants.listGrants(principalId),
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. REVOKE A GRANT (the human's kill switch)
//    POST /api/v1/mandates/intent/:id/revoke
// ═══════════════════════════════════════════════════════════════════════

router.post('/intent/:id/revoke', requireHuman, (req, res) => {
  const principalId = req.session.principal_id;
  const result = grants.revokeGrant(req.params.id, principalId);

  if (!result.ok) {
    const status = result.reason === 'GRANT_NOT_FOUND' ? 404 : 403;
    return res.status(status).json({ error: { code: result.reason, message: `Cannot revoke grant ${req.params.id}`, retriable: false } });
  }

  if (!result.alreadyRevoked) {
    sharedAuditLog.append({
      session_id: null,
      actor: Actor.HUMAN,
      event_type: EventType.STATE_TRANSITION,
      payload: {
        note: 'DELEGATION_GRANT_REVOKED',
        mandate_id: result.grant.mandate_id,
        principal_id: principalId,
        revoked_at: result.grant.revoked_at,
      },
    });
  }

  return res.json({
    mandate_id: result.grant.mandate_id,
    status: result.grant.status,
    revoked_at: result.grant.revoked_at,
    already_revoked: result.alreadyRevoked,
  });
});

module.exports = router;
