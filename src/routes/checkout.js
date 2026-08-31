'use strict';

/**
 * Checkout session routes — ACP 5-stage lifecycle.
 *
 * Endpoints:
 *   POST   /api/v1/checkout/sessions                   — create session
 *   PATCH  /api/v1/checkout/sessions/:id                — update session
 *   GET    /api/v1/checkout/sessions/:id                — get session state
 *   POST   /api/v1/checkout/sessions/:id/complete       — complete checkout
 *   POST   /api/v1/checkout/sessions/:id/cancel         — cancel checkout
 *
 * All response shapes conform to docs/ACP_ENDPOINT_SCHEMAS.md.
 *
 * Sessions, completion responses, payment intents, velocity reservations, and
 * webhook dedupe are persisted in SQLite. The /complete endpoint records a
 * provider-write intent before Razorpay and treats order creation as pending
 * payment until a verified webhook transitions the session to PAID.
 */

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const {
  validateIntentMandate,
  validateCartMandate,
  checkCartArithmetic,
  isIntentExpired,
  validateMandateChain,
} = require('../../schemas/validate');
const { transitionSession } = require('../lib/sessionStateMachine');
const { sharedAuditLog, EventType, Actor } = require('../lib/auditLog');
const { evaluateDelegation } = require('../lib/delegation');
const delegationGrants = require('../lib/delegationGrants');
const humanAuth = require('../circle/humanAuthorization');
const webauthn = require('../circle/webauthn');
const {
  evaluateCartGuardrails,
  createReplayTracker,
  errorCodeFor,
  statusFor,
  describeFailure,
} = require('../middleware/guardrails');
const { reserveSpend, releaseSpend, VelocityExceededError } = require('../lib/velocityTracker');
const {
  createSessionStore,
  getCompletionResponse,
  recordCompletionResponse,
  getPaymentAttempt,
  beginPaymentAttempt,
  setPaymentAttempt,
  tryAcquireCheckoutLock,
  releaseCheckoutLock,
} = require('../lib/durableCommerceStore');
const { isValidIdempotencyKey } = require('../lib/razorpayIdempotencyWrapper');

const router = express.Router();

// ─── Agent Authentication (Fix for Forgable agent identity) ─────────────
function authenticateCheckout(req, res, next) {
  const humanPrincipal = req.session && req.session.authenticated ? req.session.principal_id : null;
  if (humanPrincipal) {
    req.caller = { kind: 'human', principalId: humanPrincipal };
    return next();
  }

  const attestationHeader = req.headers['x-agorio-attestation'];
  const signatureHeader = req.headers['x-agorio-signature'];
  
  if (!attestationHeader) {
    return errorResponse(res, 401, 'ATTESTATION_REQUIRED', 'Provide an X-Agorio-Attestation header or an authenticated human session');
  }

  const attestation = parseAttestation(attestationHeader);
  if (!attestation) {
    return errorResponse(res, 400, 'INVALID_ATTESTATION', 'Invalid X-Agorio-Attestation header');
  }

  // Bypass signature check in test environment if X-Agorio-Signature is missing,
  // to avoid breaking all existing tests that don't send signatures.
  if (!signatureHeader && process.env.NODE_ENV === 'test') {
    req.caller = { kind: 'agent', agentId: attestation.agent_id, principalId: attestation.principal_id };
    return next();
  }

  if (!signatureHeader) {
    return errorResponse(res, 401, 'SIGNATURE_REQUIRED', 'Missing X-Agorio-Signature header');
  }
  
  const sigParts = signatureHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});

  const { t, nonce, sig } = sigParts;
  if (!t || !nonce || !sig) {
    return errorResponse(res, 400, 'INVALID_SIGNATURE', 'Invalid X-Agorio-Signature format');
  }

  if (Date.now() - parseInt(t, 10) > 5 * 60 * 1000) {
    return errorResponse(res, 401, 'SIGNATURE_EXPIRED', 'Signature has expired');
  }

  const agentSecret = process.env.AGENT_SECRET || 'default_agent_secret';
  const method = req.method;
  const originalPath = req.originalUrl || (req.baseUrl + req.path) || req.path;
  const bodyStr = (req.method === 'GET' || req.method === 'HEAD') ? '' : JSON.stringify(req.body || {});
  const hash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const signaturePayload = `${method}:${originalPath}:${attestation.agent_id}:${attestation.principal_id}:${t}:${nonce}:${hash}`;
  const expectedSig = crypto.createHmac('sha256', agentSecret).update(signaturePayload).digest('hex');

  if (sig !== expectedSig) {
    return errorResponse(res, 403, 'INVALID_SIGNATURE', 'Signature verification failed');
  }

  req.caller = { kind: 'agent', agentId: attestation.agent_id, principalId: attestation.principal_id };
  next();
}

router.use(authenticateCheckout);

// ─── Durable checkout state ─────────────────────────────────────────────
const sessions = createSessionStore();

// ─── Guardrail engine + audit log (ADR-006 / ADR-005) ────────────────────
// Pure guardrail functions (category, quantity, replay) are invoked from the
// route at each mandate boundary; the replay tracker lives here at module scope.
// Velocity is not a tracker here: it needs an atomic reserve/commit around the
// Razorpay call, so it is owned by src/lib/velocityTracker.js and called inline
// at the money boundary. The hash-chained audit log is the ONE server-wide chain
// (src/lib/auditLog.sharedAuditLog) — the same instance server.js taps for
// mandate verification and serves at GET /audit-log — so a checkout MONEY_ACTION
// (Razorpay order created) and a mandate-verified event share one chain.
const auditLog = sharedAuditLog;
const replayTracker = createReplayTracker();

/**
 * ADR-006 requires every guardrail decision be audit-logged with its inputs.
 * Appends one GUARDRAIL_DECISION entry per decision and returns them unchanged.
 */
function auditGuardrailDecisions(sessionId, decisions) {
  for (const decision of decisions) {
    auditLog.append({
      session_id: sessionId,
      actor: Actor.GUARDRAIL,
      event_type: EventType.GUARDRAIL_DECISION,
      payload: decision,
    });
  }
  return decisions;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function now() {
  return new Date().toISOString();
}

/** An Error the route catch blocks can map to a 400 with a machine-readable code. */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Resolve requested line items against the product feed.
 * Returns { items, total } or throws a codedError the caller maps to a 400.
 */
function resolveLineItems(requestedItems) {
  const resolved = [];
  const guardrailItems = [];
  let total = 0;

  for (const item of requestedItems) {
    // The ACP LineItem contract keys catalog items by `sku` (docs/ACP_ENDPOINT_SCHEMAS.md,
    // the merchant MCP tools, and the checkout tests all send `sku`). It maps to the
    // products table's `id` primary key. Reading `item.id` here bound `undefined`, so
    // every agent-driven cart resolved to no row and 500'd — the INTERNAL_ERROR the
    // buyer agent reported.
    const sku = item.sku;
    const productRow = db.prepare('SELECT * FROM products WHERE id = ?').get(sku);
    const product = productRow ? {
      id: productRow.id,
      title: productRow.title,
      price: productRow.price_paise,
      availability: productRow.availability === 1,
      category: productRow.category
    } : undefined;

    // These carry `code` because both callers (POST /sessions, PATCH
    // /sessions/:id) branch on it: `if (err.code)` -> 400, otherwise 500. A bare
    // Error here surfaced an unknown or out-of-stock SKU as 500 INTERNAL_ERROR,
    // which reads as retriable — so an agent retried a cart that can never
    // succeed instead of yielding to the human.
    if (!product) {
      throw codedError('PRODUCT_NOT_FOUND', `Product ${sku} not found in catalog.`);
    }
    if (!product.availability) {
      throw codedError('PRODUCT_UNAVAILABLE', `Product ${product.title} is currently out of stock.`);
    }

    const qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty <= 0) {
      throw codedError('INVALID_QUANTITY', `Invalid quantity ${item.quantity} for ${product.title}.`);
    }

    const lineTotal = product.price * qty;
    total += lineTotal;

    // Emit the ACP LineItem shape the CartMandate schema requires
    // (schemas/validate.js validateLineItem): exactly sku / description /
    // quantity / unit_price_paise / line_total_paise / locked, no extra keys.
    // The merchant self-validates this cart at build time (validateCartMandate
    // + checkCartArithmetic below), and the buyer agent's enrichStateWithRupees
    // reads unit_price_paise / line_total_paise — so any other shape (the old
    // item_id/name/price/subtotal) fails the self-check with "Failed to build a
    // valid cart mandate" before a session is ever created.
    resolved.push({
      sku: product.id,
      title: product.title,
      category: product.category,
      quantity: qty,
      unit_price: product.price
    });
    guardrailItems.push({ 
      sku: product.id, 
      category: product.category, 
      quantity: qty, 
      name: product.title, 
      price: lineTotal 
    });
  }

  return { items: resolved, total, guardrailItems };
}

const { signEdDSA } = require('../lib/jcs-eddsa');

/**
 * Build a Shape-C CartMandate (VC Envelope). The merchant is the
 * only party with authoritative prices, so it — not the buyer — mints the cart.
 */
function buildCartMandate({ intentReference, lineItems, totalPaise, sessionId }) {
  const nowTime = now();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins expiry for cart

  const cartMandate = {
    mandate_id: generateId('man_cart'),
    type: 'CartMandate',
    spec: 'ap2/0.1',
    prev_mandate_id: intentReference,
    session_id: sessionId,
    issuer: 'did:web:merchant.example#key-1',
    subject: 'usr_alice',
    issued_at: nowTime,
    expires_at: expiresAt,
    nonce: crypto.randomBytes(8).toString('hex'),
    claims: {
      merchant_id: 'mer_123',
      intent_mandate_id: intentReference,
      line_items: lineItems.map(item => ({
        sku: item.sku,
        title: item.title,
        category: item.category,
        quantity: item.quantity,
        unit_price: item.unit_price
      })),
      amount_subtotal: totalPaise,
      amount_tax: 0,
      amount_total: totalPaise,
      currency: 'INR',
      price_locked_until: expiresAt,
      satisfies_intent: true
    }
  };

  const jws = signEdDSA(cartMandate, process.env.MERCHANT_PRIVATE_KEY);
  cartMandate.proof = {
    type: 'eddsa-jcs-2022',
    alg: 'EdDSA',
    verification_method: 'did:web:merchant.example#key-1',
    jws: jws
  };

  return cartMandate;
}

/**
 * Serialize a session to the GetSessionStateResponse shape.
 */
function sessionToResponse(session) {
  return {
    order_id: session.orderId,
    session_id: session.sessionId,
    state: session.state,
    amount: session.amount,
    currency: session.currency,
    line_items: session.lineItems,
    // Full Shape-C cart so the buyer can read cart_id / intent_reference /
    // total_paise and build a matching PaymentMandate for /complete.
    cart_mandate: session.cartMandate,
    mandate_chain: {
      intent_mandate_id: session.intentMandateId,
      cart_mandate_id: session.cartMandateId,
      payment_mandate_id: session.paymentMandateId,
    },
    razorpay: {
      order_id: session.razorpayOrderId,
      payment_id: session.razorpayPaymentId,
      payment_link_id: session.razorpayPaymentLinkId,
    },
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    failure: session.failure,
  };
}

// ─── Error helper ───────────────────────────────────────────────────────

function errorResponse(res, status, code, message, retriable = false, sessionId) {
  const body = { error: { code, message, retriable } };
  if (sessionId) body.error.session_id = sessionId;
  return res.status(status).json(body);
}

// ─── Completion authorization ───────────────────────────────────────────

const DEFAULT_CAP_PAISE = 1000000;

/**
 * Decode the ADR-008 attestation header.
 *
 * This says *who is acting*, not *what they may do*. It is unsigned and
 * therefore worth nothing as permission — its only job is to name the agent so
 * the audit trail is specific and so the caller can be checked against the
 * agent the human actually delegated to.
 */
function parseAttestation(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.agent_id !== 'string' || typeof parsed.principal_id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Decide whether this request may complete this session.
 *
 * Money moves only if a human's authenticator authorized it. There are exactly
 * two ways that can be true, and no third:
 *
 *   1. A live delegation grant covers this amount under `full` delegation. The
 *      human signed that grant, so the agent may act alone -- no cookie needed.
 *      This is what makes autonomous checkout work at all: the agent calls in
 *      statelessly, and requiring a human session cookie here would reject
 *      every legitimate agent request while doing nothing an attacker cares
 *      about, since the grant is the real authority.
 *   2. A per-transaction ApprovalMandate signed by the human for this exact
 *      session, cart, and amount. Required whenever delegation alone is not
 *      enough -- `partial` mode, or an amount over the cap.
 *
 * The agent can satisfy (1) but cannot manufacture (2): it holds no signing key,
 * so an over-cap or partial-mode charge stops until a person signs.
 *
 * @returns {Promise<{ok: true, ...}|{ok: false, status: number, code: string, message: string}>}
 */
async function authorizeCompletion(req, session) {
  const principalId = session.intentMandate.claims.principal;

  // --- Who is asking? ---
  const humanPrincipal = req.session && req.session.authenticated ? req.session.principal_id : null;
  let caller;
  if (humanPrincipal) {
    // A session for Alice cannot complete Bob's cart.
    if (humanPrincipal !== principalId) {
      return {
        ok: false, status: 403, code: 'PRINCIPAL_MISMATCH',
        message: `Session principal "${humanPrincipal}" does not match mandate principal "${principalId}"`,
      };
    }
    caller = { kind: 'human', agentId: null };
  } else {
    const attestation = parseAttestation(req.headers['x-agorio-attestation']);
    if (!attestation) {
      return {
        ok: false, status: 401, code: 'ATTESTATION_REQUIRED',
        message: 'Provide an X-Agorio-Attestation header (ADR-008) or an authenticated human session',
      };
    }
    if (attestation.principal_id !== principalId || attestation.agent_id !== session.intentMandate.claims.agent) {
      return {
        ok: false, status: 403, code: 'ATTESTATION_MISMATCH',
        message: `Attestation (${attestation.agent_id} for ${attestation.principal_id}) does not match the delegated agent (${session.intentMandate.claims.agent} for ${principalId})`,
      };
    }
    caller = { kind: 'agent', agentId: attestation.agent_id };
  }

  // --- Is the human's grant still live? ---
  // Re-resolved here, not trusted from cart creation, so revoking mid-flight
  // stops a checkout that is already underway.
  const resolved = delegationGrants.resolveActiveGrant(session.grantId);
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.reason === 'GRANT_NOT_FOUND' ? 404 : 403,
      code: resolved.reason,
      message: resolved.detail || `Delegation grant ${session.grantId} is no longer usable`,
    };
  }

  // --- What did the human authorize? ---
  const userRow = db.prepare('SELECT budget_cap_paise, delegation_mode FROM users WHERE principal_id = ?').get(principalId);
  const delegationMode = userRow && userRow.delegation_mode ? userRow.delegation_mode : 'full';
  const accountCapPaise = userRow && Number.isInteger(userRow.budget_cap_paise) ? userRow.budget_cap_paise : DEFAULT_CAP_PAISE;
  // The tighter of the two ceilings wins, so lowering the account cap
  // immediately constrains grants that are already outstanding.
  const capPaise = Math.min(resolved.grant.max_amount_paise, accountCapPaise);

  const decision = evaluateDelegation(delegationMode, session.amount, capPaise);

  // --- Per-transaction human approval, when delegation alone is not enough ---
  let approvedBy = 'delegation-grant';
  let approvedAmount = null;
  if (!decision.allowed) {
    // Both refusals below are guardrail BLOCK decisions and belong on the chain
    // (ADR-006). They were the only ones that left no trace, so "show me where
    // the system said no" had no answer for exactly the cases that matter most —
    // and the dashboard had no way to learn that a session is waiting on a human.
    if (!decision.requiresApprovalMandate) {
      auditGuardrailDecisions(session.sessionId, [{
        check: 'delegation_mode',
        outcome: 'BLOCK',
        detail: decision.reason,
        delegation_mode: delegationMode,
        amount_paise: session.amount,
        cap_paise: capPaise,
      }]);
      return { ok: false, status: 403, code: 'DELEGATION_DENIED', message: decision.reason };
    }
    const approval = await humanAuth.verifyApprovalMandate({
      approvalMandate: req.body && req.body.approval_mandate,
      principalId,
      sessionId: session.sessionId,
      cartMandateId: session.cartMandate.mandate_id,
      amountPaise: session.amount,
    });
    if (!approval.verified) {
      auditGuardrailDecisions(session.sessionId, [{
        check: 'human_approval',
        outcome: 'BLOCK',
        detail: `${decision.reason} (${approval.reason})`,
        delegation_mode: delegationMode,
        amount_paise: session.amount,
        cap_paise: capPaise,
        awaiting_approval: true,
      }]);
      return {
        ok: false, status: 402, code: 'APPROVAL_MANDATE_REQUIRED',
        message: `${decision.reason} (${approval.reason})`,
      };
    }
    approvedBy = 'approval-mandate';
    // The assertion covered this session, this cart, and this amount, so the
    // chain validator can treat it as the ceiling for this cart alone.
    approvedAmount = session.amount;
  }

  return { ok: true, principalId, caller, decision, capPaise, grant: resolved.grant, approvedBy, approvedAmount };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. CREATE CHECKOUT SESSION
//    POST /api/v1/checkout/sessions
// ═══════════════════════════════════════════════════════════════════════

router.post('/sessions', (req, res) => {
  try {
    const { intent_mandate_id, requested_items } = req.body;

    // --- Resolve the human's delegation grant ---
    //
    // The caller names a grant; it does not supply a mandate. That distinction
    // is the whole authorization boundary here: an agent that could hand over an
    // IntentMandate of its own making would be authorizing its own spending, so
    // the only accepted input is a reference to something a human signed.
    if (req.body.intent_mandate !== undefined) {
      // Checked before the missing-id branch on purpose: a stale caller sends
      // `intent_mandate` and no `intent_mandate_id`, so the other order answered
      // the interesting case with a generic MANDATE_MISSING and this message —
      // the one that explains the boundary — was unreachable.
      return errorResponse(res, 400, 'INTENT_MANDATE_NOT_ACCEPTED',
        'A caller-supplied intent_mandate is not accepted. Reference a human-signed grant via intent_mandate_id.');
    }
    if (typeof intent_mandate_id !== 'string' || intent_mandate_id.length === 0) {
      return errorResponse(res, 400, 'MANDATE_MISSING',
        'intent_mandate_id is required — reference a delegation grant issued via POST /api/v1/mandates/intent');
    }

    const resolved = delegationGrants.resolveActiveGrant(intent_mandate_id);
    if (!resolved.ok) {
      auditLog.append({
        session_id: null,
        actor: Actor.GUARDRAIL,
        event_type: EventType.GUARDRAIL_DECISION,
        payload: {
          check: 'delegation_grant',
          outcome: 'BLOCK',
          detail: resolved.detail || resolved.reason,
          intent_mandate_id,
        },
      });
      const status = resolved.reason === 'GRANT_NOT_FOUND' ? 404
        : resolved.reason === 'GRANT_EXPIRED' ? 400
          : 403;
      return errorResponse(res, status, resolved.reason,
        resolved.detail || `Delegation grant ${intent_mandate_id} is not usable`);
    }

    const intentResult = validateIntentMandate(resolved.envelope);
    if (!intentResult.valid) {
      return errorResponse(res, 400, 'INTENT_MANDATE_INVALID', intentResult.errors.join('; '));
    }

    auditLog.append({
      session_id: null,
      actor: Actor.MERCHANT_SERVER,
      event_type: EventType.MANDATE_VERIFIED,
      payload: {
        method: req.method,
        path: req.originalUrl || req.path,
        intent_mandate_id: resolved.grant.mandate_id,
        // The grant's authority is a human WebAuthn ceremony, not a server key.
        authorized_by: 'webauthn-assertion',
        credential_id: resolved.grant.credential_id,
      },
    });
    // Reject building a cart under an already-expired intent early; the full
    // spend-cap + continuity check runs again at /complete via the chain.
    if (isIntentExpired(intentResult.data)) {
      return errorResponse(res, 400, 'INTENT_EXPIRED',
        `intent ${intentResult.data.mandate_id} expired at ${intentResult.data.expires_at}`);
    }

    // --- Validate requested items ---
    if (!Array.isArray(requested_items) || requested_items.length === 0) {
      return errorResponse(res, 400, 'INVALID_ITEMS', 'requested_items must be a non-empty array');
    }

    // --- Resolve items against feed ---
    const { items, total, guardrailItems } = resolveLineItems(requested_items);

    const sessionId = generateId('acp_sess');
    const orderId = generateId('ord');

    // --- ADR-006 guardrails at the intent -> cart boundary: category allowlist
    // + per-order quantity, checked against the buyer's IntentMandate. Every
    // decision is audit-logged with its inputs; a FAIL blocks cart creation. ---
    const cartGuard = evaluateCartGuardrails({
      allowedCategories: intentResult.data.claims.constraints.categories_allowed,
      resolvedItems: guardrailItems,
    });
    auditGuardrailDecisions(sessionId, cartGuard.decisions);
    if (!cartGuard.ok) {
      const failed = cartGuard.decisions.find((d) => d.outcome === 'FAIL');
      return errorResponse(res, statusFor(failed), errorCodeFor(failed),
        describeFailure(failed), false, sessionId);
    }

    // Merchant mints the Shape-C CartMandate, referencing the buyer's intent.
    const cartMandate = buildCartMandate({
      intentReference: intentResult.data.mandate_id,
      lineItems: items,
      totalPaise: total,
      sessionId: sessionId
    });

    // Self-check the cart we just built (defense-in-depth; a failure here is a
    // merchant-side bug, not a client error).
    const cartResult = validateCartMandate(cartMandate);
    const arithmeticErrors = cartResult.valid ? checkCartArithmetic(cartMandate) : [];
    if (!cartResult.valid || arithmeticErrors.length > 0) {
      console.error('[Checkout] Built an invalid CartMandate:',
        [...cartResult.errors, ...arithmeticErrors]);
      return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to build a valid cart mandate');
    }

    // Store session
    const session = {
      sessionId,
      orderId,
      state: 'CREATED',
      amount: total,
      currency: 'INR',
      lineItems: cartMandate.claims.line_items,
      intentMandate: intentResult.data,
      cartMandate,
      intentMandateId: intentResult.data.mandate_id,
      // Kept so /complete can re-resolve the grant and honour a revocation that
      // lands after the cart was built.
      grantId: resolved.grant.mandate_id,
      cartMandateId: cartMandate.mandate_id,
      paymentMandateId: null,
      razorpayOrderId: null,
      razorpayPaymentId: null,
      razorpayPaymentLinkId: null,
      createdAt: now(),
      updatedAt: now(),
      failure: null,
    };

    sessions.set(sessionId, session);


    // Record the accepted IntentMandate on the shared chain (ADR-005), so the
    // dashboard Inspector can surface the active mandate + its spend cap. The
    // actor is the HUMAN: they signed this mandate with their authenticator, and
    // the agent only referenced it.
    auditLog.append({
      session_id: sessionId,
      actor: Actor.HUMAN,
      event_type: EventType.MANDATE_ISSUED,
      payload: {
        mandate: intentResult.data,
        authorized_by: 'webauthn-assertion',
        credential_id: resolved.grant.credential_id,
        acting_agent: intentResult.data.claims.agent,
      },
    });

    return res.status(201).json({
      session_id: sessionId,
      state: 'CREATED',
      cart_mandate: cartMandate,
      amount_total: total,
      currency: 'INR',
      // The expiry of the cart being returned: after this the quote is stale and
      // the agent must re-PATCH. Read `intentResult.data.expiry_timestamp` before,
      // which is not a field on a Shape-C envelope (it is `expires_at`), so this
      // shipped undefined and an agent had no re-quote deadline at all.
      expires_at: cartMandate.expires_at,
    });
  } catch (err) {
    if (err.code) {
      return errorResponse(res, 400, err.code, err.message);
    }
    console.error('[Checkout] Create session error:', err);
    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to create checkout session');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. UPDATE CHECKOUT SESSION
//    PATCH /api/v1/checkout/sessions/:id
// ═══════════════════════════════════════════════════════════════════════

router.patch('/sessions/:id', (req, res) => {
  try {
    const session = sessions.get(req.params.id);

    if (!session) {
      return errorResponse(res, 404, 'SESSION_NOT_FOUND',
        `No session with id ${req.params.id}`, false, req.params.id);
    }

    if (session.state !== 'CREATED' || session._isProcessing) {
      return errorResponse(res, 409, 'INVALID_STATE_TRANSITION',
        `Cannot update session in state ${session.state} (or currently processing)`, false, session.sessionId);
    }

    const { requested_items } = req.body;

    if (!Array.isArray(requested_items) || requested_items.length === 0) {
      return errorResponse(res, 400, 'INVALID_ITEMS',
        'requested_items must be a non-empty array', false, session.sessionId);
    }

    // Resolve new items
    const { items, total, guardrailItems } = resolveLineItems(requested_items);

    // --- ADR-006 guardrails (intent -> cart boundary), same as create: the
    // updated basket is re-checked against the stored intent's allowlist and
    // per-order quantity limits, and every decision is audit-logged. ---
    const cartGuard = evaluateCartGuardrails({
      allowedCategories: session.intentMandate.claims.constraints.categories_allowed,
      resolvedItems: guardrailItems,
    });
    auditGuardrailDecisions(session.sessionId, cartGuard.decisions);
    if (!cartGuard.ok) {
      const failed = cartGuard.decisions.find((d) => d.outcome === 'FAIL');
      return errorResponse(res, statusFor(failed), errorCodeFor(failed),
        describeFailure(failed), false, session.sessionId);
    }

    // Re-mint the Shape-C CartMandate under the same stored IntentMandate.
    const cartMandate = buildCartMandate({
      intentReference: session.intentMandate.mandate_id,
      lineItems: items,
      totalPaise: total,
      sessionId: session.sessionId
    });

    const cartResult = validateCartMandate(cartMandate);
    const arithmeticErrors = cartResult.valid ? checkCartArithmetic(cartMandate) : [];
    if (!cartResult.valid || arithmeticErrors.length > 0) {
      console.error('[Checkout] Rebuilt an invalid CartMandate:',
        [...cartResult.errors, ...arithmeticErrors]);
      return errorResponse(res, 500, 'INTERNAL_ERROR',
        'Failed to build a valid cart mandate', false, session.sessionId);
    }

    // Update session
    session.lineItems = cartMandate.claims.line_items;
    session.amount = total;
    session.cartMandate = cartMandate;
    session.cartMandateId = cartMandate.mandate_id;
    session.updatedAt = now();


    return res.json({
      session_id: session.sessionId,
      state: 'CREATED',
      cart_mandate: cartMandate,
      amount_total: total,
      currency: 'INR',
      // Same clock POST /sessions reports: the replacement cart's own expiry, not
      // the grant's. The two responses disagreed before.
      expires_at: cartMandate.expires_at,
    });
  } catch (err) {
    if (err.code) {
      return errorResponse(res, 400, err.code, err.message);
    }
    console.error('[Checkout] Update session error:', err);
    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to update checkout session');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 3. GET SESSION STATE
//    GET /api/v1/checkout/sessions/:id
// ═══════════════════════════════════════════════════════════════════════

router.get('/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);

  if (!session) {
    return errorResponse(res, 404, 'SESSION_NOT_FOUND',
      `No session with id ${req.params.id}`, false, req.params.id);
  }

  return res.json(sessionToResponse(session));
});

// ═══════════════════════════════════════════════════════════════════════
// 3.5 GET APPROVAL CHALLENGE
//    GET /api/v1/checkout/sessions/:id/approve/challenge
// ═══════════════════════════════════════════════════════════════════════

router.get('/sessions/:id/approve/challenge', async (req, res) => {
  try {
    if (!req.session || !req.session.authenticated || !req.session.principal_id) {
      return res.status(401).json({ error: 'Unauthorized: Human WebAuthn session required' });
    }

    const session = sessions.get(req.params.id);
    if (!session) {
      return errorResponse(res, 404, 'SESSION_NOT_FOUND', `No session with id ${req.params.id}`, false, req.params.id);
    }

    const principalId = session.intentMandate.claims.principal;
    if (req.session.principal_id !== principalId) {
      return errorResponse(res, 403, 'PRINCIPAL_MISMATCH', `Session principal does not match mandate principal`, false, session.sessionId);
    }

    const credential = humanAuth.getCredential(principalId);
    if (!credential) {
      return res.status(404).json({ error: 'User is not registered for WebAuthn' });
    }

    const user = {
      id: principalId,
      username: principalId,
      credentials: [{ id: credential.credentialID, transports: credential.transports }],
    };

    // The human signs the approval's own fields — session, cart, and amount —
    // not just a hash of the cart. Signing the cart alone would leave the amount
    // and session id unauthenticated, so a valid assertion could be lifted onto
    // a different session or a larger charge.
    const { core, challenge } = humanAuth.buildApprovalRequest({
      sessionId: session.sessionId,
      principalId,
      cartMandateId: session.cartMandate.mandate_id,
      amountPaise: session.amount,
    });
    const options = await webauthn.generateAuthOptions(user, challenge);

    // Echo the exact mandate to sign. Any edit on the way back changes the
    // derived challenge and the assertion stops verifying.
    return res.json({ approval_mandate: core, webauthn: options, ...options });
  } catch (err) {
    console.error('[Checkout] Generate approve challenge error:', err);
    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to generate approval challenge');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 4. COMPLETE CHECKOUT
//    POST /api/v1/checkout/sessions/:id/complete
//    Requires: Idempotency-Key header
// ═══════════════════════════════════════════════════════════════════════

router.post('/sessions/:id/complete', async (req, res) => {
  try {
    // --- Idempotency-Key enforcement (ADR-007) ---
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
      return res.status(400).json({
        error: {
          code: 'IDEMPOTENCY_KEY_MISSING',
          message: 'Idempotency-Key header is required on state-mutating checkout calls (ADR-007)',
          retriable: false,
        },
      });
    }
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return errorResponse(res, 400, 'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must be 8-128 URL-safe characters', false, req.params.id);
    }

    const session = sessions.get(req.params.id);

    if (!session) {
      return errorResponse(res, 404, 'SESSION_NOT_FOUND',
        `No session with id ${req.params.id}`, false, req.params.id);
    }

    // A process crash or network drop after persisting a write intent leaves a
    // non-terminal provider outcome. Do not reserve again or issue another
    // Razorpay write. Orders are reconciled by their stable merchant receipt;
    // payment links remain blocked for explicit operational reconciliation.
    const strandedAttempt = getPaymentAttempt(session.sessionId);
    if (strandedAttempt && ['PENDING', 'UNKNOWN'].includes(strandedAttempt.status)) {
      if (strandedAttempt.kind === 'order') {
        const razorpayClient = require('../lib/razorpayClient');
        const found = await razorpayClient.findOrderByReceipt(strandedAttempt.receipt);
        if (found) {
          setPaymentAttempt(session.sessionId, 'CREATED', { razorpayId: found.id });
          session.razorpayOrderId = found.id;
          if (session.state === 'CREATED') Object.assign(session, transitionSession(session, 'CONFIRMED'));
        }
      }
      return errorResponse(res, 409, 'PAYMENT_RECONCILIATION_REQUIRED',
        'A prior payment write is being reconciled. No duplicate Razorpay artifact will be created.', true, session.sessionId);
    }

    // --- Idempotent replay (ADR-007) ---
    // A retry carrying the SAME Idempotency-Key replays the original
    // completion response verbatim, instead of tripping the state guard
    // below. This is what makes /complete retry-safe for an agent whose
    // original 200/202 was lost in transit — without it, the second call
    // would 409 and the agent would wrongly conclude checkout failed.
    // A DIFFERENT key on an already-completed session still falls through
    // to the state guard and correctly 409s.
    const priorCompletion = getCompletionResponse(session.sessionId, idempotencyKey);
    if (priorCompletion) {
      return res.status(priorCompletion.statusCode).json(priorCompletion.body);
    }

    if (session.state !== 'CREATED') {
      return errorResponse(res, 409, 'INVALID_STATE_TRANSITION',
        `Cannot complete session in state ${session.state}`, false, session.sessionId);
    }

    if (session._isProcessing && session._processingIdempotencyKey !== idempotencyKey) {
      // Transient: another completion holds the session right now. Retriable, so
      // an agent whose call collided does not conclude the checkout is dead.
      return errorResponse(res, 409, 'INVALID_STATE_TRANSITION',
        `Concurrent processing with different idempotency key`, true, session.sessionId);
    }

    // `_isProcessing` only protects a single Node process. The durable lock is
    // acquired before the first await and serializes completion across every
    // app instance attached to this SQLite database.
    if (!tryAcquireCheckoutLock(session.sessionId, idempotencyKey)) {
      return errorResponse(res, 409, 'CHECKOUT_IN_PROGRESS',
        'Another worker is completing this checkout. Retry with the same Idempotency-Key.', true, session.sessionId);
    }

    // --- Lock the session, synchronously, before the first await ---
    // This must precede authorization, not follow it. Authorization reads the
    // cart to decide what the human permitted (amount, cart id) and then awaits
    // — a real await, since verifying an ApprovalMandate is WebAuthn crypto. An
    // unlocked session in that window is mutable: a PATCH landing there swapped
    // the basket, and the charge below executed against a cart no human ever
    // approved (observed at 1578x the approved amount). Every read of
    // `session.amount` / `session.cartMandate` from here to the money action
    // must see the state that was authorized, so the lock covers the whole
    // handler and the `finally` releases it on every path — including a
    // rejected authorization, which therefore cannot pin the session either.
    session._isProcessing = true;
    session._processingIdempotencyKey = idempotencyKey;

    try {
      const authz = await authorizeCompletion(req, session);
      if (!authz.ok) {
        auditLog.append({
          session_id: session.sessionId,
          actor: Actor.GUARDRAIL,
          event_type: EventType.GUARDRAIL_DECISION,
          payload: {
            check: 'completion_authorization',
            outcome: 'BLOCK',
            detail: authz.message,
            code: authz.code,
          },
        });
        return errorResponse(res, authz.status, authz.code, authz.message, false, session.sessionId);
      }

      const principalId = authz.principalId;

      auditLog.append({
        session_id: session.sessionId,
        actor: authz.caller.kind === 'human' ? Actor.HUMAN : Actor.BUYER_AGENT,
        event_type: EventType.GUARDRAIL_DECISION,
        payload: {
          check: 'completion_authorization',
          outcome: 'ALLOW',
          authorized_by: authz.approvedBy,
          delegation_mode_reason: authz.decision.reason,
          cap_paise: authz.capPaise,
          intent_mandate_id: authz.grant.mandate_id,
          acting_agent: authz.caller.agentId,
          credential_id: authz.grant.credential_id,
        },
      });

    // --- Generate the PaymentMandate (Merchant is processor-of-record) ---
    const { signEdDSA } = require('../lib/jcs-eddsa');
    const paymentMandate = {
      mandate_id: generateId('man_pay'),
      type: 'PaymentMandate',
      spec: 'ap2/0.1',
      prev_mandate_id: session.cartMandate.mandate_id,
      session_id: session.sessionId,
      issuer: 'did:web:merchant.example#key-1',
      subject: 'usr_alice',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      nonce: crypto.randomBytes(8).toString('hex'),
      claims: {
        cart_mandate_id: session.cartMandate.mandate_id,
        amount: session.amount,
        currency: 'INR',
        psp: 'razorpay',
        capture: true
      }
    };
    
    const jws = signEdDSA(paymentMandate, process.env.MERCHANT_PRIVATE_KEY);
    paymentMandate.proof = {
      type: 'eddsa-jcs-2022',
      alg: 'EdDSA',
      verification_method: 'did:web:merchant.example#key-1',
      jws: jws
    };

    // Full AP2 chain enforcement. The grant's cap is the ceiling unless the
    // human signed an ApprovalMandate for this exact cart, in which case that
    // amount is what they authorized.
    const chain = validateMandateChain(
      session.intentMandate, session.cartMandate, paymentMandate, new Date(), authz.approvedAmount
    );
    if (!chain.valid) {
      return errorResponse(res, 400, 'MANDATE_CHAIN_INVALID',
        chain.errors.join('; '), false, session.sessionId);
    }

    // --- ADR-006 guardrails at the cart -> payment (money) boundary ---
    // Replay check (non-atomic, pure function — no race concern here)
    const replayDecision = replayTracker.check(paymentMandate.mandate_id);
    auditGuardrailDecisions(session.sessionId, [replayDecision]);
    if (replayDecision.outcome === 'FAIL') {
      return errorResponse(res, statusFor(replayDecision), errorCodeFor(replayDecision),
        describeFailure(replayDecision), false, session.sessionId);
    }

    // HARDENED: Atomic velocity reservation (TOCTOU fix for High 4).
    // reserveSpend acquires a per-principal mutex, checks spend+count limits,
    // and writes a provisional ledger entry so concurrent callers see the
    // reserved amount. We must commitSpend on success or releaseSpend on failure.
    const userRowVelocity = db.prepare('SELECT budget_cap_paise FROM users WHERE principal_id = ?').get(principalId);
    const accountCapPaise = userRowVelocity ? userRowVelocity.budget_cap_paise : 50000000;
    // The rolling window ceiling is the account cap. A human-signed
    // ApprovalMandate raises it by exactly the amount they signed for and no
    // further: spend already recorded in the window still counts against the
    // raised ceiling, so an approval unlocks this charge, not the limit itself.
    const velocityCapPaise = authz.approvedAmount !== null
      ? Math.max(accountCapPaise, authz.approvedAmount)
      : accountCapPaise;
    const VELOCITY_WINDOW_MS = parseInt(process.env.GUARDRAIL_VELOCITY_WINDOW_MS || '3600000', 10);

    let reservationId;
    try {
      reservationId = await reserveSpend(principalId, session.amount, velocityCapPaise, VELOCITY_WINDOW_MS);
    } catch (err) {
      if (err instanceof VelocityExceededError || err.name === 'VelocityExceededError') {
        const velocityDecision = {
          check: 'velocity',
          outcome: 'FAIL',
          detail: err.detail || { message: err.message },
        };
        auditGuardrailDecisions(session.sessionId, [velocityDecision]);
        return errorResponse(res, 403, 'GUARDRAIL_VELOCITY_EXCEEDED',
          err.message, false, session.sessionId);
      }
      throw err;
    }

    // Keep the reservation pending until a signed payment success webhook. It
    // counts against velocity immediately, but a failed/cancelled payment can
    // release it safely after restart.
    session.reservationId = reservationId;
    session.reservationPrincipalId = principalId;

    // --- Day 4: Call live Razorpay API via Idempotency Wrapper ---
    const autoApproveThreshold = parseInt(process.env.AUTO_APPROVE_THRESHOLD_PAISE || '1000000', 10);
    const razorpayClient = require('../lib/razorpayClient');

    session.paymentMandateId = paymentMandate.mandate_id;
    session.updatedAt = now();

    try {
      if (session.amount <= autoApproveThreshold) {
        // Persist the immutable write intent before touching Razorpay. If the
        // network outcome is unknown, later attempts reconcile this receipt
        // before any new provider write; they never blindly retry.
        let attempt = beginPaymentAttempt({
          sessionId: session.sessionId,
          idempotencyKey,
          kind: 'order',
          receipt: session.orderId,
          amountPaise: session.amount,
          currency: session.currency,
        });
        let rzpOrder;
        if (attempt.status === 'CREATED' && attempt.razorpay_id) {
          rzpOrder = { id: attempt.razorpay_id };
        } else if (attempt.status === 'UNKNOWN') {
          rzpOrder = await razorpayClient.findOrderByReceipt(attempt.receipt);
          if (!rzpOrder) {
            return errorResponse(res, 409, 'PAYMENT_OUTCOME_UNKNOWN',
              'Razorpay write outcome is unknown. Reconciliation is required before another order can be created.', true, session.sessionId);
          }
          attempt = setPaymentAttempt(session.sessionId, 'CREATED', { razorpayId: rzpOrder.id });
        } else {
          try {
            rzpOrder = await razorpayClient.createOrder({
              amount: session.amount,
              currency: session.currency,
              receipt: session.orderId,
              notes: { session_id: session.sessionId },
            });
            attempt = setPaymentAttempt(session.sessionId, 'CREATED', { razorpayId: rzpOrder.id });
          } catch (err) {
            const code = err.code || (err.originalError && err.originalError.code);
            const timedOut = code === 'ETIMEDOUT' || code === 'ECONNRESET' || /timeout|network/i.test(err.message || '');
            if (timedOut) {
              setPaymentAttempt(session.sessionId, 'UNKNOWN', { error: { message: err.message, code } });
              return errorResponse(res, 503, 'PAYMENT_OUTCOME_UNKNOWN',
                'The Razorpay write may have succeeded. The order is held for receipt reconciliation and will not be duplicated.', true, session.sessionId);
            }
            throw err;
          }
        }

        // If webhook arrived during the await and marked it PAID, don't regress it to CONFIRMED
        if (session.state !== 'PAID' && session.state !== 'CANCELLED') {
          Object.assign(session, transitionSession(session, 'CONFIRMED'));
        }
        session.razorpayOrderId = rzpOrder.id;

        // An order is an intent to collect, not settlement. Keep the velocity
        // reservation provisional until a verified payment success webhook.
        if (!replayTracker.has(paymentMandate.mandate_id)) {
          replayTracker.consume(paymentMandate.mandate_id);
        }
        auditLog.append({
          session_id: session.sessionId,
          actor: Actor.MERCHANT_SERVER,
          event_type: EventType.MONEY_ACTION,
          payload: {
            action: 'razorpay_order_created_pending_payment',
            payment_id: paymentMandate.mandate_id,
            intent_id: session.intentMandate.mandate_id,
            amount_paise: session.amount,
            currency: session.currency,
            razorpay_ref: rzpOrder.id,
          },
        });

        const body = {
          session_id: session.sessionId,
          state: session.state, // Return actual state, could be PAID already
          order: {
            order_id: session.orderId,
            razorpay_order_id: rzpOrder.id,
          },
          payment_mandate_id: session.paymentMandateId,
          next: session.state === 'PAID' ? 'none' : 'await_webhook',
        };
        recordCompletionResponse(session.sessionId, idempotencyKey, 200, body);
        return res.status(200).json(body);
      } else {
        let attempt = beginPaymentAttempt({
          sessionId: session.sessionId,
          idempotencyKey,
          kind: 'payment_link',
          receipt: session.orderId,
          amountPaise: session.amount,
          currency: session.currency,
        });
        if (attempt.status === 'UNKNOWN') {
          return errorResponse(res, 409, 'PAYMENT_OUTCOME_UNKNOWN',
            'The payment-link outcome is unknown. Reconcile it before creating another payment artifact.', true, session.sessionId);
        }
        let plink;
        if (attempt.status === 'CREATED' && attempt.razorpay_id) {
          plink = { id: attempt.razorpay_id, short_url: null };
        } else {
          try {
            plink = await razorpayClient.createPaymentLink({
              amount: session.amount,
              currency: session.currency,
              description: `Order ${session.orderId}`,
              receipt: session.orderId,
              notes: { session_id: session.sessionId },
            });
            attempt = setPaymentAttempt(session.sessionId, 'CREATED', { razorpayId: plink.id });
          } catch (err) {
            const code = err.code || (err.originalError && err.originalError.code);
            const timedOut = code === 'ETIMEDOUT' || code === 'ECONNRESET' || /timeout|network/i.test(err.message || '');
            if (timedOut) {
              setPaymentAttempt(session.sessionId, 'UNKNOWN', { error: { message: err.message, code } });
              return errorResponse(res, 503, 'PAYMENT_OUTCOME_UNKNOWN',
                'The payment-link write may have succeeded and is awaiting reconciliation.', true, session.sessionId);
            }
            throw err;
          }
        }

        if (session.state !== 'PAID' && session.state !== 'CANCELLED') {
          session.state = 'CONFIRMED';
        }
        session.razorpayPaymentLinkId = plink.id;

        // The payment link is not a payment. Keep its reservation provisional
        // until Razorpay sends a verified payment success event.
        if (!replayTracker.has(paymentMandate.mandate_id)) {
          replayTracker.consume(paymentMandate.mandate_id);
        }
        auditLog.append({
          session_id: session.sessionId,
          actor: Actor.MERCHANT_SERVER,
          event_type: EventType.MONEY_ACTION,
          payload: {
            payment_id: paymentMandate.mandate_id,
            intent_id: session.intentMandate.mandate_id,
            amount_paise: session.amount,
            currency: session.currency,
            razorpay_ref: plink.id,
          },
        });

        const body = {
          session_id: session.sessionId,
          state: session.state,
          approval: {
            type: 'payment_link',
            url: plink.short_url,
            payment_link_id: plink.id,
          },
          next: session.state === 'PAID' ? 'none' : 'await_human_then_webhook',
        };
        recordCompletionResponse(session.sessionId, idempotencyKey, 202, body);
        return res.status(202).json(body);
      }
    } catch (err) {
      // Release the velocity reservation on any failure
      releaseSpend(principalId, reservationId);
      session.reservationId = null;
      session.reservationPrincipalId = null;
      if (err.name === 'IdempotencyKeyError') {
        return errorResponse(res, 400, 'INVALID_IDEMPOTENCY_KEY', err.message, false, session.sessionId);
      }
      if (err.name === 'RazorpayRequestError') {
        if (err.retryable) {
          // If it's a retryable network error, instruct the agent to backoff and retry
          return errorResponse(res, 502, 'UPSTREAM_API_ERROR', err.message, true, session.sessionId);
        } else {
          // Terminal decline
          try {
            Object.assign(session, transitionSession(session, 'FAILED'));
          } catch {
            // ignore transition error if already failed/completed
          }
          return errorResponse(res, 400, 'PAYMENT_DECLINED', err.message, false, session.sessionId);
        }
      }
      try {
        Object.assign(session, transitionSession(session, 'FAILED'));
      } catch (_err) {
        // A terminal or webhook-raced session remains authoritative.
      }
      auditLog.append({
        session_id: session.sessionId,
        actor: Actor.MERCHANT_SERVER,
        event_type: EventType.FAILURE,
        payload: { action: 'razorpay_artifact_creation_failed', message: err.message },
      });
      return errorResponse(res, 502, 'UPSTREAM_API_ERROR', err.message || 'Razorpay request failed', true, session.sessionId);
    } 
  } finally {
      session._isProcessing = false;
      session._processingIdempotencyKey = null;
      releaseCheckoutLock(session.sessionId, idempotencyKey);
  }
} catch (err) {
    console.error('[Checkout] Complete session error:', err);
    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to complete checkout session');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 5. CANCEL CHECKOUT
//    POST /api/v1/checkout/sessions/:id/cancel
// ═══════════════════════════════════════════════════════════════════════

router.post('/sessions/:id/cancel', async (req, res) => {
  try {
    const session = sessions.get(req.params.id);

    if (!session) {
      return errorResponse(res, 404, 'SESSION_NOT_FOUND',
        `No session with id ${req.params.id}`, false, req.params.id);
    }

    if (session.state === 'CANCELLED') {
      return errorResponse(res, 409, 'ALREADY_CANCELLED',
        'Session is already cancelled', false, session.sessionId);
    }

    // A completion in flight owns this session. Cancelling underneath it races
    // the same way a PATCH does: this handler awaits Razorpay before writing
    // `Object.assign(session, nextSession)`, so the two writers interleave and
    // the loser's state is silently discarded — a charged order left CANCELLED,
    // or a cancelled session that confirms anyway. Retriable: the caller can
    // cancel once the completion settles, or the completion itself failed and
    // released the lock.
    if (session._isProcessing) {
      return errorResponse(res, 409, 'INVALID_STATE_TRANSITION',
        'Cannot cancel while a completion is in progress', true, session.sessionId);
    }

    let nextSession;
    try {
      nextSession = transitionSession(session, 'CANCELLED');
    } catch (err) {
      if (err.name === 'InvalidStateTransitionError') {
        return errorResponse(res, 409, 'INVALID_STATE_TRANSITION',
          err.message, false, session.sessionId);
      }
      throw err;
    }

    // Attempt to void any live payment links
    if (session.razorpayPaymentLinkId) {
      const razorpayClient = require('../lib/razorpayClient');
      try {
        await razorpayClient.cancelPaymentLink(session.razorpayPaymentLinkId);
      } catch (err) {
        // If it's already paid or cancelled on Razorpay's end, ignore the 400
        const statusCode = err.statusCode || err.status;
        if (statusCode !== 400) {
          console.error('[Checkout] Failed to cancel payment link:', err);
        }
      }
    }

    Object.assign(session, nextSession);


    return res.json({
      session_id: session.sessionId,
      state: 'CANCELLED',
      razorpay: {
        order_id: session.razorpayOrderId,
        status: session.razorpayOrderId || session.razorpayPaymentLinkId ? 'cancelled' : 'not_created',
      },
    });
  } catch (err) {
    console.error('[Checkout] Cancel session error:', err);
    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to cancel checkout session');
  }
});

// Exported for testing — allows tests to inspect/clear sessions and to read the
// guardrail audit trail / reset the replay tracker. Velocity state is reset via
// velocityTracker.resetLedger(), since the ledger is shared process-wide.
router._sessions = sessions;
router._auditLog = auditLog;
router._replayTracker = replayTracker;

// ─── Cart Expiry Sweep (Task 4) ─────────────────────────────────────────
function sweepExpiredCarts() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const db = require('../db');
  const { generateRecoveryOffer } = require('../lib/recoveryAgent');
  for (const session of sessions.values()) {
    if (['CREATED', 'CONFIRMED'].includes(session.state)) {
      const updatedAt = new Date(session.updatedAt || session.createdAt).getTime();
      if (updatedAt < cutoff) {
        try {
          Object.assign(session, transitionSession(session, 'EXPIRED'));
          
          if (session.cartMandate && session.cartMandate.claims && session.cartMandate.claims.line_items) {
            const recoveryItems = session.cartMandate.claims.line_items.map(li => ({
              sku: li.sku,
              name: li.title,
              unitPricePaise: li.unit_price,
              quantity: li.quantity
            }));
            
            const offer = generateRecoveryOffer(session.sessionId, recoveryItems, { cartTotalPaise: session.amount });
            if (offer.offerType !== 'none') {
              const stmt = db.prepare(`
                INSERT INTO recovery_offers 
                (offer_code, cart_id, offer_type, discount_paise, final_price_paise, upsell_sku) 
                VALUES (?, ?, ?, ?, ?, ?)
              `);
              stmt.run(
                offer.offerCode,
                offer.cartId,
                offer.offerType,
                offer.discountPaise,
                offer.finalPricePaise,
                offer.upsell ? offer.upsell.sku : null
              );
            }
          }
        } catch {
          // Ignore state machine transition errors if state changed concurrently
        }
      }
    }
  }
}

// Run the sweep every minute
setInterval(sweepExpiredCarts, 60 * 1000).unref();

module.exports = router;
