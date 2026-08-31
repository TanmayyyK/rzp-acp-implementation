'use strict';

/**
 * chaosEngine.js
 * ---------------------------------------------------------------------------
 * Isolated chaos / fault-injection middleware for the ACP checkout backend.
 *
 * Lets QA and dev deliberately drive specific failure states by sending an
 * `x-chaos-mode` header. Nothing here touches the database, the in-memory
 * session store, or a real payment provider — every effect is request-scoped
 * (mutations live only on `req`, discarded when the response is sent) or a
 * pure in-memory mock. It is deliberately NOT wired into server.js; mount it
 * yourself at the boundaries below when you want a route to be chaos-able.
 *
 * MODES
 * -----
 *   price-spike  — simulate a price change between cart pricing and payment.
 *                  Inflates every price-bearing field it finds on the request
 *                  by 25% (in-memory only), then short-circuits 409 so the
 *                  inflated cart never reaches the mandate/pricing logic.
 *   card-decline — simulate an issuer decline at Razorpay order creation.
 *                  Builds a mock Razorpay `payment.failed` webhook payload,
 *                  emits it on `chaosEvents` (so a test harness can feed it to
 *                  the real webhook handler), stashes it on `req.chaosWebhook`,
 *                  then short-circuits 402.
 *
 * WHERE TO MOUNT (real routes in this backend)
 * --------------------------------------------
 *   const { chaosGuard, priceSpike, cardDecline } = require('../middleware/chaosEngine');
 *
 *   // Optional: mount once near the top so req.chaosMode is available for logs.
 *   app.use(chaosGuard);
 *
 *   // price-spike: the CartMandate is minted (priced) in POST /sessions, so
 *   // that is the "just before the mandate is formed" boundary.
 *   router.post('/sessions', priceSpike, createSessionHandler);
 *
 *   // card-decline: the Razorpay order is created inside POST /sessions/:id/complete.
 *   router.post('/sessions/:id/complete', cardDecline, completeSessionHandler);
 *
 * TRIGGERING
 * ----------
 *   curl -H "x-chaos-mode: price-spike"  .../api/v1/checkout/sessions
 *   curl -H "x-chaos-mode: card-decline" .../api/v1/checkout/sessions/<id>/complete
 *
 * SAFETY (strict opt-in — safe to import in any build)
 * ----------------------------------------------------
 *   - process.env.NODE_ENV must NOT be 'production'
 *   - process.env.CHAOS_ENGINE_ENABLED must be exactly 'true'
 * If either fails, every exported middleware is a pure pass-through (`next()`),
 * regardless of the header sent.
 * ---------------------------------------------------------------------------
 */

const { EventEmitter } = require('events');

const CHAOS_MODES = Object.freeze({
  PRICE_SPIKE: 'price-spike',
  CARD_DECLINE: 'card-decline',
});

const CHAOS_ENABLED =
  process.env.CHAOS_ENGINE_ENABLED === 'true' && process.env.NODE_ENV !== 'production';

const SPIKE_PERCENT = 25;

// Emits mock webhook events instead of making any real HTTP call. Attach your
// own listener (e.g. in a test harness) via chaosEvents.on('payment.failed', ...).
const chaosEvents = new EventEmitter();

// Monotonic suffix so rapidly-emitted mock events always get distinct ids —
// the real webhook handler (src/routes/webhooks.js) dedupes on event.id, so two
// chaos events must never collide into a single "already_processed".
let mockSeq = 0;

/**
 * Optional top-level guard. Reads the header once and stashes it on
 * `req.chaosMode` for logging/debugging. Safe to mount globally — it never
 * short-circuits a request itself.
 */
function chaosGuard(req, res, next) {
  req.chaosMode = CHAOS_ENABLED ? req.get('x-chaos-mode') || null : null;
  next();
}

/**
 * price-spike — mount at the cart-pricing / mandate-forming boundary
 * (POST /api/v1/checkout/sessions in this backend).
 *
 * Inflates every price-bearing field found on the request by 25% (in-memory
 * only — never persisted, never written to the session store or DB), then
 * short-circuits 409 so the inflated cart never reaches the pricing/mandate
 * logic. The inflation summary is attached to `req.chaos` for inspection.
 */
function priceSpike(req, res, next) {
  if (!CHAOS_ENABLED || req.get('x-chaos-mode') !== CHAOS_MODES.PRICE_SPIKE) {
    return next();
  }

  const spike = inflateRequestPrices(req.body, SPIKE_PERCENT);
  req.chaos = { mode: CHAOS_MODES.PRICE_SPIKE, priceSpike: spike };

  return res.status(409).json({
    error: 'PRICE_MISMATCH',
    message: 'Item price changed mid-checkout.',
  });
}

/**
 * card-decline — mount at the Razorpay order-creation boundary
 * (POST /api/v1/checkout/sessions/:id/complete in this backend).
 *
 * Builds a mock Razorpay `payment.failed` webhook, emits it on `chaosEvents`
 * (for any listener — e.g. a test wiring it into the real webhook handler),
 * stashes it on `req.chaosWebhook`, then short-circuits 402.
 */
function cardDecline(req, res, next) {
  if (!CHAOS_ENABLED || req.get('x-chaos-mode') !== CHAOS_MODES.CARD_DECLINE) {
    return next();
  }

  const mockWebhook = buildMockPaymentFailedWebhook(req);
  req.chaosWebhook = mockWebhook;
  req.chaos = { mode: CHAOS_MODES.CARD_DECLINE, webhook: mockWebhook };
  chaosEvents.emit('payment.failed', mockWebhook);

  return res.status(402).json({
    error: 'PAYMENT_DECLINED',
    reason: 'insufficient_funds',
  });
}

// --- helpers ----------------------------------------------------------------

// Bump an integer paise amount by `percent`, staying an integer (rupee amounts
// in this backend are always integer paise — see schemas/validate.js).
function inflatePaise(paise, percent) {
  return Math.round(Number(paise) * (1 + percent / 100));
}

// Bump a generic (possibly fractional) amount by `percent`, to 2 decimals.
function inflateAmount(amount, percent) {
  return Math.round(Number(amount) * (1 + percent / 100) * 100) / 100;
}

/**
 * Inflate every price-bearing field this backend might place on a request
 * body, in place and in-memory only. Handles both the paise line-item shape
 * (unit_price_paise / line_total_paise / total_paise / final_paise) and the
 * generic price / subtotal / total / amount shape. Returns a summary of what
 * changed for inspection/logging. Never persists anything.
 */
function inflateRequestPrices(body, percent) {
  const summary = { percent, fieldsInflated: 0, itemsInflated: 0 };
  if (!body || typeof body !== 'object') return summary;

  const bumpPaise = (obj, key) => {
    if (obj && Number.isInteger(obj[key])) {
      obj[key] = inflatePaise(obj[key], percent);
      summary.fieldsInflated += 1;
      return true;
    }
    return false;
  };
  const bumpAmount = (obj, key) => {
    if (obj && typeof obj[key] === 'number') {
      obj[key] = inflateAmount(obj[key], percent);
      summary.fieldsInflated += 1;
      return true;
    }
    return false;
  };

  // Line items may live under a few different keys depending on the boundary.
  const itemArrays = [
    body.line_items,
    body.items,
    body.cart && body.cart.items,
    body.cart_mandate && body.cart_mandate.line_items,
  ];
  for (const items of itemArrays) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const changed =
        // paise shape (CartMandate line items)
        [bumpPaise(item, 'unit_price_paise'), bumpPaise(item, 'line_total_paise'),
          // generic shape
          bumpAmount(item, 'price'), bumpAmount(item, 'subtotal')].some(Boolean);
      if (changed) summary.itemsInflated += 1;
    }
  }

  // Totals across the shapes this backend uses.
  bumpPaise(body, 'total_paise');
  bumpPaise(body, 'amount'); // Razorpay orders/paise
  bumpPaise(body.payment_mandate, 'final_paise');
  bumpPaise(body.cart_mandate, 'total_paise');
  bumpAmount(body, 'total');
  if (body.cart) bumpAmount(body.cart, 'total');

  return summary;
}

/**
 * Build a mock Razorpay `payment.failed` webhook that matches the envelope the
 * real handler (src/routes/webhooks.js) actually reads: a top-level `event` and
 * `id` (used for dedup + logging), and `payload.payment.entity` with `id`,
 * `order_id`, and `notes.session_id` for session correlation.
 */
function buildMockPaymentFailedWebhook(req) {
  const body = (req && req.body) || {};
  const seq = ++mockSeq;
  const stamp = Date.now();

  const sessionId = body.session_id || (req && req.params && req.params.id) || null;
  const orderId = body.order_id || body.orderId || `order_chaos_${stamp}_${seq}`;
  const amount =
    body.amount ||
    (body.payment_mandate && body.payment_mandate.final_paise) ||
    (body.cart_mandate && body.cart_mandate.total_paise) ||
    (body.cart && body.cart.total) ||
    0;
  const currency = body.currency || 'INR';

  return {
    entity: 'event',
    // Distinct per emit so the real handler's event.id dedup treats each as new.
    id: `evt_chaos_${stamp}_${seq}`,
    event: 'payment.failed',
    contains: ['payment'],
    created_at: Math.floor(stamp / 1000),
    payload: {
      payment: {
        entity: {
          id: `pay_chaos_${stamp}_${seq}`,
          entity: 'payment',
          order_id: orderId,
          status: 'failed',
          amount,
          currency,
          method: 'card',
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Insufficient funds in the customer account.',
          error_reason: 'insufficient_funds',
          error_source: 'issuer',
          error_step: 'payment_authorization',
          notes: sessionId ? { session_id: sessionId } : {},
        },
      },
    },
    _chaosGenerated: true, // never carries a real Razorpay signature — do not verify as one
  };
}

module.exports = {
  chaosGuard,
  priceSpike,
  cardDecline,
  chaosEvents,
  CHAOS_MODES,
};
