'use strict';

/**
 * Unit tests for the chaos / fault-injection middleware
 * (src/middleware/chaosEngine.js).
 *
 * Pure — no Express server, no sockets, no Razorpay — so they run in this
 * sandbox (which blocks port binding). The middleware is invoked directly with
 * mock req/res/next, matching the guardrails.test.js style.
 *
 * The enable double-gate (CHAOS_ENGINE_ENABLED === 'true' && NODE_ENV !==
 * 'production') is read at module load, so we set it BEFORE requiring, and use
 * jest.isolateModules to load a disabled instance for the pass-through test.
 */

process.env.CHAOS_ENGINE_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { chaosGuard, priceSpike, cardDecline, chaosEvents, CHAOS_MODES } =
  require('../src/middleware/chaosEngine');

// --- mock req/res -----------------------------------------------------------

function mockReq({ headers = {}, body = {}, params = {} } = {}) {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return {
    headers,
    body,
    params,
    get(name) {
      return lower[String(name).toLowerCase()];
    },
  };
}

function mockRes() {
  return {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────

describe('chaosGuard', () => {
  test('stashes the chaos-mode header on req and always calls next', () => {
    const req = mockReq({ headers: { 'x-chaos-mode': 'price-spike' } });
    const next = jest.fn();
    chaosGuard(req, mockRes(), next);
    expect(req.chaosMode).toBe('price-spike');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('priceSpike', () => {
  test('409 PRICE_MISMATCH with the exact payload and does NOT call next', () => {
    const req = mockReq({ headers: { 'x-chaos-mode': CHAOS_MODES.PRICE_SPIKE } });
    const res = mockRes();
    const next = jest.fn();

    priceSpike(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'PRICE_MISMATCH',
      message: 'Item price changed mid-checkout.',
    });
  });

  test('inflates paise line items + totals by 25% in-memory only', () => {
    const body = {
      cart_mandate: {
        total_paise: 20000,
        line_items: [
          { sku: 'x', quantity: 2, unit_price_paise: 8000, line_total_paise: 16000 },
        ],
      },
      payment_mandate: { final_paise: 20000 },
    };
    const req = mockReq({ headers: { 'x-chaos-mode': CHAOS_MODES.PRICE_SPIKE }, body });
    priceSpike(req, mockRes(), jest.fn());

    // 25% inflation, still integer paise.
    expect(body.cart_mandate.line_items[0].unit_price_paise).toBe(10000);
    expect(body.cart_mandate.line_items[0].line_total_paise).toBe(20000);
    expect(body.cart_mandate.total_paise).toBe(25000);
    expect(body.payment_mandate.final_paise).toBe(25000);
    expect(req.chaos.priceSpike.itemsInflated).toBe(1);
  });

  test('passes through (next) when the header is absent or a different mode', () => {
    for (const headers of [{}, { 'x-chaos-mode': 'card-decline' }, { 'x-chaos-mode': 'nope' }]) {
      const req = mockReq({ headers });
      const res = mockRes();
      const next = jest.fn();
      priceSpike(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeUndefined();
    }
  });
});

describe('cardDecline', () => {
  test('402 PAYMENT_DECLINED with the exact payload and does NOT call next', () => {
    const req = mockReq({ headers: { 'x-chaos-mode': CHAOS_MODES.CARD_DECLINE } });
    const res = mockRes();
    const next = jest.fn();

    cardDecline(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.body).toEqual({ error: 'PAYMENT_DECLINED', reason: 'insufficient_funds' });
  });

  test('emits a payment.failed webhook matching the shape webhooks.js reads', () => {
    const received = [];
    const listener = (evt) => received.push(evt);
    chaosEvents.on('payment.failed', listener);

    const req = mockReq({
      headers: { 'x-chaos-mode': CHAOS_MODES.CARD_DECLINE },
      body: { session_id: 'acp_sess_abc', order_id: 'order_xyz' },
    });
    cardDecline(req, mockRes(), jest.fn());

    chaosEvents.off('payment.failed', listener);

    expect(received).toHaveLength(1);
    const evt = received[0];
    // Fields the real handler (src/routes/webhooks.js) actually reads:
    expect(evt.event).toBe('payment.failed');
    expect(typeof evt.id).toBe('string'); // used for dedup + logging
    const entity = evt.payload.payment.entity;
    expect(typeof entity.id).toBe('string');
    expect(entity.order_id).toBe('order_xyz');
    expect(entity.notes.session_id).toBe('acp_sess_abc'); // session correlation
    expect(evt.error_reason || entity.error_reason).toBe('insufficient_funds');
    // And it's stashed on req for inspection.
    expect(req.chaosWebhook).toBe(evt);
  });

  test('successive emits get distinct event ids (real handler dedupes on id)', () => {
    const a = mockReq({ headers: { 'x-chaos-mode': CHAOS_MODES.CARD_DECLINE } });
    const b = mockReq({ headers: { 'x-chaos-mode': CHAOS_MODES.CARD_DECLINE } });
    cardDecline(a, mockRes(), jest.fn());
    cardDecline(b, mockRes(), jest.fn());
    expect(a.chaosWebhook.id).not.toBe(b.chaosWebhook.id);
    expect(a.chaosWebhook.payload.payment.entity.id)
      .not.toBe(b.chaosWebhook.payload.payment.entity.id);
  });

  test('passes through (next) when the header is absent or a different mode', () => {
    for (const headers of [{}, { 'x-chaos-mode': 'price-spike' }]) {
      const req = mockReq({ headers });
      const res = mockRes();
      const next = jest.fn();
      cardDecline(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeUndefined();
    }
  });
});

describe('disabled (opt-in gate off)', () => {
  test('every middleware is a pure pass-through, ignoring the header', () => {
    const prev = process.env.CHAOS_ENGINE_ENABLED;
    delete process.env.CHAOS_ENGINE_ENABLED;
    jest.isolateModules(() => {
      const chaos = require('../src/middleware/chaosEngine');
      let emitted = 0;
      chaos.chaosEvents.on('payment.failed', () => { emitted += 1; });

      for (const mw of [chaos.priceSpike, chaos.cardDecline]) {
        const req = mockReq({ headers: { 'x-chaos-mode': 'price-spike' } });
        const res = mockRes();
        const next = jest.fn();
        mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeUndefined();
      }
      expect(emitted).toBe(0);
    });
    process.env.CHAOS_ENGINE_ENABLED = prev;
  });
});
