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
 * State is held in an in-memory Map for now (swapped for a DB on Day 5+).
 * The /complete endpoint does NOT call Razorpay today — it validates the
 * schema, records the mandate, and returns a simulated success response.
 */

const crypto = require('crypto');
const express = require('express');
const { getMockProductFeed } = require('../lib/mockProductFeed');
const { createIdempotencyWrapper } = require('../lib/razorpayIdempotencyWrapper');

const router = express.Router();
const rzpIdempotency = createIdempotencyWrapper();

// ─── In-memory session store ────────────────────────────────────────────
const sessions = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function now() {
  return new Date().toISOString();
}

function expiresIn(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

/**
 * Resolve requested line items against the product feed.
 * Returns { items, total } or throws with a descriptive error.
 */
function resolveLineItems(requestedItems) {
  const feed = getMockProductFeed();
  const resolved = [];
  let total = 0;

  for (const item of requestedItems) {
    if (!item.sku && !item.id) {
      throw { code: 'INVALID_LINE_ITEM', message: 'Each item must have a sku or id' };
    }

    const product = feed.find(
      (p) => p.id === (item.id || item.sku) || p.id === item.sku
    );

    if (!product) {
      throw { code: 'PRODUCT_NOT_FOUND', message: `Product not found: ${item.sku || item.id}` };
    }

    if (!product.availability) {
      throw { code: 'PRODUCT_UNAVAILABLE', message: `Product out of stock: ${product.id}` };
    }

    const qty = item.quantity || 1;
    const lineTotal = product.price * qty;
    total += lineTotal;

    resolved.push({
      sku: product.id,
      title: product.title,
      category: 'electronics',
      quantity: qty,
      unit_price: product.price,
    });
  }

  return { items: resolved, total };
}

/**
 * Build a stub SignedMandate envelope.
 * In production this would be cryptographically signed with EdDSA.
 */
function buildStubMandate({ type, sessionId, prevMandateId, claims }) {
  return {
    mandate_id: generateId('mnd'),
    type,
    spec: 'ACP-2.0',
    prev_mandate_id: prevMandateId || null,
    session_id: sessionId,
    issuer: 'merchant:agentic-commerce-node',
    subject: 'buyer-agent',
    issued_at: now(),
    expires_at: expiresIn(30),
    nonce: crypto.randomBytes(16).toString('hex'),
    claims: claims || {},
    proof: {
      type: 'Ed25519Signature2020',
      alg: 'EdDSA',
      verification_method: 'did:key:merchant#key-1',
      jws: 'stub_signature_' + crypto.randomBytes(32).toString('base64url'),
    },
  };
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

// ═══════════════════════════════════════════════════════════════════════
// 1. CREATE CHECKOUT SESSION
//    POST /api/v1/checkout/sessions
// ═══════════════════════════════════════════════════════════════════════

router.post('/sessions', (req, res) => {
  try {
    const { intent_mandate, requested_items } = req.body;

    // --- Validate intent mandate ---
    if (!intent_mandate || typeof intent_mandate !== 'object') {
      return errorResponse(res, 400, 'MANDATE_MISSING', 'intent_mandate is required');
    }
    if (intent_mandate.type && intent_mandate.type !== 'IntentMandate') {
      return errorResponse(res, 400, 'MANDATE_TYPE_MISMATCH',
        `Expected IntentMandate, got ${intent_mandate.type}`);
    }

    // --- Validate requested items ---
    if (!Array.isArray(requested_items) || requested_items.length === 0) {
      return errorResponse(res, 400, 'INVALID_ITEMS', 'requested_items must be a non-empty array');
    }

    // --- Resolve items against feed ---
    const { items, total } = resolveLineItems(requested_items);

    const sessionId = generateId('acp_sess');
    const orderId = generateId('ord');

    // Build the CartMandate
    const cartMandate = buildStubMandate({
      type: 'CartMandate',
      sessionId,
      prevMandateId: intent_mandate.mandate_id || null,
      claims: {
        amount: total,
        currency: 'INR',
        line_items: items,
      },
    });

    // Store session
    const session = {
      sessionId,
      orderId,
      state: 'CREATED',
      amount: total,
      currency: 'INR',
      lineItems: items,
      intentMandateId: intent_mandate.mandate_id || null,
      cartMandateId: cartMandate.mandate_id,
      paymentMandateId: null,
      razorpayOrderId: null,
      razorpayPaymentId: null,
      razorpayPaymentLinkId: null,
      createdAt: now(),
      updatedAt: now(),
      failure: null,
      _cartMandate: cartMandate,
    };

    sessions.set(sessionId, session);

    console.log(`[Checkout] Session created: ${sessionId} (${items.length} items, ₹${total / 100})`);

    return res.status(201).json({
      session_id: sessionId,
      state: 'CREATED',
      cart_mandate: cartMandate,
      amount_total: total,
      currency: 'INR',
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

    if (session.state !== 'CREATED') {
      return errorResponse(res, 409, 'INVALID_STATE_TRANSITION',
        `Cannot update session in state ${session.state}`, false, session.sessionId);
    }

    const { requested_items } = req.body;

    if (!Array.isArray(requested_items) || requested_items.length === 0) {
      return errorResponse(res, 400, 'INVALID_ITEMS',
        'requested_items must be a non-empty array', false, session.sessionId);
    }

    // Resolve new items
    const { items, total } = resolveLineItems(requested_items);

    // Re-issue CartMandate with new nonce
    const cartMandate = buildStubMandate({
      type: 'CartMandate',
      sessionId: session.sessionId,
      prevMandateId: session.cartMandateId,
      claims: {
        amount: total,
        currency: 'INR',
        line_items: items,
      },
    });

    // Update session
    session.lineItems = items;
    session.amount = total;
    session.cartMandateId = cartMandate.mandate_id;
    session._cartMandate = cartMandate;
    session.updatedAt = now();

    console.log(`[Checkout] Session updated: ${session.sessionId} (₹${total / 100})`);

    return res.json({
      session_id: session.sessionId,
      state: 'CREATED',
      cart_mandate: cartMandate,
      amount_total: total,
      currency: 'INR',
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

    const session = sessions.get(req.params.id);

    if (!session) {
      return errorResponse(res, 404, 'SESSION_NOT_FOUND',
        `No session with id ${req.params.id}`, false, req.params.id);
    }

    if (session.state !== 'CREATED') {
      return errorResponse(res, 409, 'INVALID_STATE_TRANSITION',
        `Cannot complete session in state ${session.state}`, false, session.sessionId);
    }

    const { payment_mandate } = req.body;

    if (!payment_mandate || typeof payment_mandate !== 'object') {
      return errorResponse(res, 400, 'MANDATE_MISSING',
        'payment_mandate is required', false, session.sessionId);
    }
    if (payment_mandate.type && payment_mandate.type !== 'PaymentMandate') {
      return errorResponse(res, 400, 'MANDATE_TYPE_MISMATCH',
        `Expected PaymentMandate, got ${payment_mandate.type}`, false, session.sessionId);
    }

    // --- Day 4: Call live Razorpay API via Idempotency Wrapper ---
    const autoApproveThreshold = parseInt(process.env.AUTO_APPROVE_THRESHOLD_PAISE || '1000000', 10);
    const razorpayClient = require('../lib/razorpayClient');

    session.paymentMandateId = payment_mandate.mandate_id || generateId('mnd');
    session.updatedAt = now();

    try {
      if (session.amount <= autoApproveThreshold) {
        // Auto-approved path: POST /v1/orders
        const rzpOrder = await rzpIdempotency.execute(idempotencyKey, () =>
          razorpayClient.createOrder({
            amount: session.amount,
            currency: session.currency,
            receipt: session.orderId,
            notes: { session_id: session.sessionId },
          })
        );

        session.state = 'CONFIRMED';
        session.razorpayOrderId = rzpOrder.id;
        console.log(`[Checkout] Session completed (auto-approved): ${session.sessionId} -> ${rzpOrder.id}`);

        return res.status(200).json({
          session_id: session.sessionId,
          state: 'CONFIRMED',
          order: {
            order_id: session.orderId,
            razorpay_order_id: rzpOrder.id,
          },
          payment_mandate_id: session.paymentMandateId,
          next: 'await_webhook',
        });
      } else {
        // Escalated path: POST /v1/payment_links
        const plink = await rzpIdempotency.execute(idempotencyKey, () =>
          razorpayClient.createPaymentLink({
            amount: session.amount,
            currency: session.currency,
            description: `Order ${session.orderId}`,
            receipt: session.orderId,
            notes: { session_id: session.sessionId },
          })
        );

        session.state = 'CONFIRMED';
        session.razorpayPaymentLinkId = plink.id;
        console.log(`[Checkout] Session completed (escalated): ${session.sessionId} -> ${plink.id}`);

        return res.status(202).json({
          session_id: session.sessionId,
          state: 'CONFIRMED',
          approval: {
            type: 'payment_link',
            url: plink.short_url,
            payment_link_id: plink.id,
          },
          next: 'await_human_then_webhook',
        });
      }
    } catch (err) {
      if (err.name === 'IdempotencyKeyError') {
        return errorResponse(res, 400, 'INVALID_IDEMPOTENCY_KEY', err.message, false, session.sessionId);
      }
      if (err.name === 'RazorpayRequestError') {
        // If it's a retryable network error, instruct the agent to backoff and retry
        return errorResponse(res, 502, 'UPSTREAM_API_ERROR', err.message, err.retryable, session.sessionId);
      }
      throw err;
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

    if (session.state === 'PAID' || session.state === 'COMPLETED') {
      return errorResponse(res, 409, 'INVALID_STATE_TRANSITION',
        `Cannot cancel session in state ${session.state}`, false, session.sessionId);
    }

    // Attempt to void any live payment links
    if (session.razorpayPaymentLinkId) {
      const razorpayClient = require('../lib/razorpayClient');
      try {
        await razorpayClient.cancelPaymentLink(session.razorpayPaymentLinkId);
        console.log(`[Checkout] Voided Razorpay Payment Link: ${session.razorpayPaymentLinkId}`);
      } catch (err) {
        // If it's already paid or cancelled on Razorpay's end, ignore the 400
        const statusCode = err.statusCode || err.status;
        if (statusCode !== 400) {
          console.error('[Checkout] Failed to cancel payment link:', err);
        }
      }
    }

    session.state = 'CANCELLED';
    session.updatedAt = now();

    console.log(`[Checkout] Session cancelled: ${session.sessionId}`);

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

// Exported for testing — allows tests to inspect/clear sessions
router._sessions = sessions;

module.exports = router;
