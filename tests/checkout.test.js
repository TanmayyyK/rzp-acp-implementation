'use strict';

const request = require('supertest');
const app = require('../src/server');
const checkoutRouter = require('../src/routes/checkout');

// Mock Razorpay client to avoid real API calls during tests
jest.mock('../src/lib/razorpayClient', () => ({
  createOrder: jest.fn(async (params) => ({ id: 'order_simulated_mock', ...params })),
  createPaymentLink: jest.fn(async (params) => ({ id: 'plink_simulated_mock', short_url: 'https://rzp.io/i/plink_simulated_mock', ...params })),
  cancelPaymentLink: jest.fn(async (id) => ({ id, status: 'cancelled' })),
}));

// Clear the in-memory session store between tests
beforeEach(() => {
  checkoutRouter._sessions.clear();
});

// ─── Helpers ────────────────────────────────────────────────────────────

function stubIntentMandate(overrides = {}) {
  return {
    mandate_id: 'mnd_intent_test_001',
    type: 'IntentMandate',
    spec: 'ACP-2.0',
    prev_mandate_id: null,
    session_id: null,
    issuer: 'buyer-agent:test',
    subject: 'merchant',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    nonce: 'test_nonce_001',
    claims: { budget_paise: 500000, intent: 'buy_earbuds' },
    proof: { type: 'Ed25519Signature2020', alg: 'EdDSA', verification_method: 'did:key:buyer#1', jws: 'stub' },
    ...overrides,
  };
}

function stubPaymentMandate(overrides = {}) {
  return {
    mandate_id: 'mnd_payment_test_001',
    type: 'PaymentMandate',
    spec: 'ACP-2.0',
    prev_mandate_id: null,
    session_id: null,
    issuer: 'buyer-agent:test',
    subject: 'merchant',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    nonce: 'test_nonce_002',
    claims: { authorized_amount: 179900, currency: 'INR' },
    proof: { type: 'Ed25519Signature2020', alg: 'EdDSA', verification_method: 'did:key:buyer#1', jws: 'stub' },
    ...overrides,
  };
}

async function createSession() {
  const res = await request(app)
    .post('/api/v1/checkout/sessions')
    .send({
      intent_mandate: stubIntentMandate(),
      requested_items: [{ sku: 'prod_electronics_001', quantity: 1 }],
    });
  return res;
}

// ═══════════════════════════════════════════════════════════════════════
// FEED ROUTE
// ═══════════════════════════════════════════════════════════════════════

describe('GET /feed', () => {
  test('short alias and /api/v1/feed both return the ACP product feed', async () => {
    const short = await request(app).get('/feed');
    const namespaced = await request(app).get('/api/v1/feed');
    expect(short.statusCode).toBe(200);
    expect(namespaced.statusCode).toBe(200);
    expect(short.body.protocol).toBe('ACP');
    expect(short.body.products.length).toBe(namespaced.body.products.length);
  });
});

describe('GET /api/v1/feed', () => {
  test('returns 200 with ACP product feed', async () => {
    const res = await request(app).get('/api/v1/feed');
    expect(res.statusCode).toBe(200);
    expect(res.body.version).toBe('2.0');
    expect(res.body.protocol).toBe('ACP');
    expect(res.body.feed_type).toBe('product_catalog');
    expect(res.body.currency).toBe('INR');
    expect(res.body.products.length).toBe(3);
    expect(res.body.count).toBe(3);
    expect(res.body.generated_at).toBeDefined();
  });

  test('feed products have ACP-compliant integer paise prices', async () => {
    const res = await request(app).get('/api/v1/feed');
    res.body.products.forEach((p) => {
      expect(Number.isInteger(p.price)).toBe(true);
      expect(p.currency).toBe('INR');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 1. CREATE CHECKOUT SESSION
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/v1/checkout/sessions', () => {
  test('201 — creates session with correct schema', async () => {
    const res = await createSession();
    expect(res.statusCode).toBe(201);
    expect(res.body.session_id).toMatch(/^acp_sess_/);
    expect(res.body.state).toBe('CREATED');
    expect(res.body.amount_total).toBe(179900); // Boult earbuds ₹1,799
    expect(res.body.currency).toBe('INR');
    expect(res.body.expires_at).toBeDefined();

    // Cart mandate shape
    const cm = res.body.cart_mandate;
    expect(cm.mandate_id).toMatch(/^mnd_/);
    expect(cm.type).toBe('CartMandate');
    expect(cm.spec).toBe('ACP-2.0');
    expect(cm.prev_mandate_id).toBe('mnd_intent_test_001');
    expect(cm.session_id).toBe(res.body.session_id);
    expect(cm.proof.type).toBe('Ed25519Signature2020');
  });

  test('400 — missing intent_mandate', async () => {
    const res = await request(app)
      .post('/api/v1/checkout/sessions')
      .send({ requested_items: [{ sku: 'prod_electronics_001', quantity: 1 }] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('MANDATE_MISSING');
  });

  test('400 — empty requested_items', async () => {
    const res = await request(app)
      .post('/api/v1/checkout/sessions')
      .send({ intent_mandate: stubIntentMandate(), requested_items: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ITEMS');
  });

  test('400 — product not found', async () => {
    const res = await request(app)
      .post('/api/v1/checkout/sessions')
      .send({
        intent_mandate: stubIntentMandate(),
        requested_items: [{ sku: 'prod_nonexistent', quantity: 1 }],
      });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  test('400 — out of stock product', async () => {
    const res = await request(app)
      .post('/api/v1/checkout/sessions')
      .send({
        intent_mandate: stubIntentMandate(),
        requested_items: [{ sku: 'prod_electronics_003', quantity: 1 }],
      });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  test('multi-item session calculates total correctly', async () => {
    const res = await request(app)
      .post('/api/v1/checkout/sessions')
      .send({
        intent_mandate: stubIntentMandate(),
        requested_items: [
          { sku: 'prod_electronics_001', quantity: 2 }, // 179900 * 2
          { sku: 'prod_electronics_002', quantity: 1 }, // 199900
        ],
      });
    expect(res.statusCode).toBe(201);
    expect(res.body.amount_total).toBe(179900 * 2 + 199900);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. UPDATE CHECKOUT SESSION
// ═══════════════════════════════════════════════════════════════════════

describe('PATCH /api/v1/checkout/sessions/:id', () => {
  test('200 — updates items and re-issues CartMandate', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;
    const oldMandateId = created.body.cart_mandate.mandate_id;

    const res = await request(app)
      .patch(`/api/v1/checkout/sessions/${sessionId}`)
      .send({ requested_items: [{ sku: 'prod_electronics_002', quantity: 1 }] });

    expect(res.statusCode).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.state).toBe('CREATED');
    expect(res.body.amount_total).toBe(199900); // Mi Power Bank
    expect(res.body.cart_mandate.mandate_id).not.toBe(oldMandateId); // New mandate
    expect(res.body.cart_mandate.prev_mandate_id).toBe(oldMandateId); // Chains to old
  });

  test('404 — session not found', async () => {
    const res = await request(app)
      .patch('/api/v1/checkout/sessions/acp_sess_nonexistent')
      .send({ requested_items: [{ sku: 'prod_electronics_001', quantity: 1 }] });
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  test('400 — empty requested_items on update', async () => {
    const created = await createSession();
    const res = await request(app)
      .patch(`/api/v1/checkout/sessions/${created.body.session_id}`)
      .send({ requested_items: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ITEMS');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. GET SESSION STATE
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/v1/checkout/sessions/:id', () => {
  test('200 — returns full session state with correct schema', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    const res = await request(app).get(`/api/v1/checkout/sessions/${sessionId}`);
    expect(res.statusCode).toBe(200);

    // Top-level
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.state).toBe('CREATED');
    expect(res.body.order_id).toMatch(/^ord_/);
    expect(res.body.amount).toBe(179900);
    expect(res.body.currency).toBe('INR');

    // Line items
    expect(res.body.line_items).toHaveLength(1);
    expect(res.body.line_items[0].sku).toBe('prod_electronics_001');
    expect(res.body.line_items[0].unit_price).toBe(179900);

    // Mandate chain
    expect(res.body.mandate_chain.intent_mandate_id).toBe('mnd_intent_test_001');
    expect(res.body.mandate_chain.cart_mandate_id).toMatch(/^mnd_/);
    expect(res.body.mandate_chain.payment_mandate_id).toBeNull();

    // Razorpay
    expect(res.body.razorpay.order_id).toBeNull();
    expect(res.body.razorpay.payment_id).toBeNull();
    expect(res.body.razorpay.payment_link_id).toBeNull();

    // Timestamps
    expect(res.body.created_at).toBeDefined();
    expect(res.body.updated_at).toBeDefined();
    expect(res.body.failure).toBeNull();
  });

  test('404 — session not found', async () => {
    const res = await request(app).get('/api/v1/checkout/sessions/acp_sess_nonexistent');
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. COMPLETE CHECKOUT
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/v1/checkout/sessions/:id/complete', () => {
  test('400 — missing Idempotency-Key', async () => {
    const created = await createSession();
    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${created.body.session_id}/complete`)
      .send({ payment_mandate: stubPaymentMandate() });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_MISSING');
  });

  test('200 — auto-approved (under threshold)', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set('Idempotency-Key', 'idem_test_001')
      .send({ payment_mandate: stubPaymentMandate() });

    expect(res.statusCode).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.state).toBe('CONFIRMED');
    expect(res.body.order.order_id).toMatch(/^ord_/);
    expect(res.body.order.razorpay_order_id).toMatch(/^order_simulated_/);
    expect(res.body.payment_mandate_id).toBe('mnd_payment_test_001');
    expect(res.body.next).toBe('await_webhook');
  });

  test('202 — escalated (over threshold)', async () => {
    // Create a session with a large amount (2 items * earbuds = ₹3,598)
    // Set the threshold very low
    const origThreshold = process.env.AUTO_APPROVE_THRESHOLD_PAISE;
    process.env.AUTO_APPROVE_THRESHOLD_PAISE = '100'; // 1 rupee

    const created = await createSession();
    const sessionId = created.body.session_id;

    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set('Idempotency-Key', 'idem_test_002')
      .send({ payment_mandate: stubPaymentMandate() });

    expect(res.statusCode).toBe(202);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.state).toBe('CONFIRMED');
    expect(res.body.approval.type).toBe('payment_link');
    expect(res.body.approval.url).toMatch(/^https:\/\/rzp\.io\/i\//);
    expect(res.body.approval.payment_link_id).toMatch(/^plink_simulated_/);
    expect(res.body.next).toBe('await_human_then_webhook');

    // Restore
    if (origThreshold !== undefined) {
      process.env.AUTO_APPROVE_THRESHOLD_PAISE = origThreshold;
    } else {
      delete process.env.AUTO_APPROVE_THRESHOLD_PAISE;
    }
  });

  test('400 — missing payment_mandate', async () => {
    const created = await createSession();
    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${created.body.session_id}/complete`)
      .set('Idempotency-Key', 'idem_test_003')
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('MANDATE_MISSING');
  });

  test('409 — cannot complete twice', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    // First complete
    await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set('Idempotency-Key', 'idem_test_004a')
      .send({ payment_mandate: stubPaymentMandate() });

    // Second complete
    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set('Idempotency-Key', 'idem_test_004b')
      .send({ payment_mandate: stubPaymentMandate() });

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  test('idempotent replay — same Idempotency-Key replays the original response, not a 409', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    const first = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set('Idempotency-Key', 'idem_replay_001')
      .send({ payment_mandate: stubPaymentMandate() });

    // Same key, replayed as if the original 200 was lost in transit.
    const retry = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set('Idempotency-Key', 'idem_replay_001')
      .send({ payment_mandate: stubPaymentMandate() });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200); // must NOT 409 — this is the retry-safety guarantee
    expect(retry.body).toEqual(first.body); // byte-for-byte replay of the original completion
  });

  test('session state is CONFIRMED after complete', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set('Idempotency-Key', 'idem_test_005')
      .send({ payment_mandate: stubPaymentMandate() });

    const state = await request(app).get(`/api/v1/checkout/sessions/${sessionId}`);
    expect(state.body.state).toBe('CONFIRMED');
    expect(state.body.mandate_chain.payment_mandate_id).toBe('mnd_payment_test_001');
    expect(state.body.razorpay.order_id).toMatch(/^order_simulated_/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. CANCEL CHECKOUT
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/v1/checkout/sessions/:id/cancel', () => {
  test('200 — cancels a CREATED session', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/cancel`)
      .send();

    expect(res.statusCode).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.state).toBe('CANCELLED');
    expect(res.body.razorpay.order_id).toBeNull();
    expect(res.body.razorpay.status).toBe('not_created');
  });

  test('200 — cancels a CONFIRMED session (order created but unpaid)', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    // Complete it first
    await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/complete`)
      .set('Idempotency-Key', 'idem_cancel_001')
      .send({ payment_mandate: stubPaymentMandate() });

    // Cancel it
    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${sessionId}/cancel`)
      .send();

    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe('CANCELLED');
    expect(res.body.razorpay.order_id).toMatch(/^order_simulated_/);
    expect(res.body.razorpay.status).toBe('cancelled');
  });

  test('409 — cannot cancel already cancelled session', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    // Cancel once
    await request(app).post(`/api/v1/checkout/sessions/${sessionId}/cancel`).send();

    // Cancel again
    const res = await request(app).post(`/api/v1/checkout/sessions/${sessionId}/cancel`).send();
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CANCELLED');
  });

  test('404 — session not found', async () => {
    const res = await request(app)
      .post('/api/v1/checkout/sessions/acp_sess_nonexistent/cancel')
      .send();
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  test('session state is CANCELLED after cancel', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    await request(app).post(`/api/v1/checkout/sessions/${sessionId}/cancel`).send();

    const state = await request(app).get(`/api/v1/checkout/sessions/${sessionId}`);
    expect(state.body.state).toBe('CANCELLED');
  });

  test('cannot update a cancelled session', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    await request(app).post(`/api/v1/checkout/sessions/${sessionId}/cancel`).send();

    const res = await request(app)
      .patch(`/api/v1/checkout/sessions/${sessionId}`)
      .send({ requested_items: [{ sku: 'prod_electronics_002', quantity: 1 }] });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SHORT ALIASES — /session
// ═══════════════════════════════════════════════════════════════════════

describe('short /session aliases', () => {
  test('POST /session creates a session with the schema shape', async () => {
    const res = await request(app)
      .post('/session')
      .send({
        intent_mandate: stubIntentMandate(),
        requested_items: [{ sku: 'prod_electronics_001', quantity: 1 }],
      });
    expect(res.statusCode).toBe(201);
    expect(res.body.session_id).toMatch(/^acp_sess_/);
    expect(res.body.state).toBe('CREATED');
    expect(res.body.cart_mandate.type).toBe('CartMandate');
    expect(res.body.amount_total).toBe(179900);
    expect(res.body.currency).toBe('INR');
  });

  test('GET /session/:id, PATCH, complete, and cancel share the in-memory store', async () => {
    const created = await request(app)
      .post('/session')
      .send({
        intent_mandate: stubIntentMandate(),
        requested_items: [{ sku: 'prod_electronics_001', quantity: 1 }],
      });
    const sessionId = created.body.session_id;

    const patched = await request(app)
      .patch(`/session/${sessionId}`)
      .send({ requested_items: [{ sku: 'prod_electronics_002', quantity: 1 }] });
    expect(patched.statusCode).toBe(200);
    expect(patched.body.amount_total).toBe(199900);

    const got = await request(app).get(`/session/${sessionId}`);
    expect(got.statusCode).toBe(200);
    expect(got.body.amount).toBe(199900);
    expect(got.body.mandate_chain.cart_mandate_id).toBe(patched.body.cart_mandate.mandate_id);

    const completed = await request(app)
      .post(`/session/${sessionId}/complete`)
      .set('Idempotency-Key', 'idem_alias_001')
      .send({ payment_mandate: stubPaymentMandate() });
    expect(completed.statusCode).toBe(200);
    expect(completed.body.next).toBe('await_webhook');
    expect(completed.body.order.razorpay_order_id).toMatch(/^order_simulated_/);

    const cancelled = await request(app).post(`/session/${sessionId}/cancel`).send();
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body.state).toBe('CANCELLED');
  });
});
