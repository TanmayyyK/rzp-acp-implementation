'use strict';

/**
 * Surface-level contracts for the app as a whole: ACP discovery, health, the
 * products catalogue, webhook signature verification, and the two guards that
 * sit in front of every /complete call.
 *
 * Driven socket-free via tests/helpers/inject.js. This suite used to use
 * supertest, which calls app.listen() — blocked in this sandbox (EPERM), and an
 * unhandled 'error' on the Server crashes the whole jest process, so the entire
 * gate went dark rather than reporting one failure.
 */

const crypto = require('crypto');
const { inject } = require('./helpers/inject');

const SECRET = 'test_webhook_secret_123';

// webhooks.js reads process.env per request, so setting it here is enough.
beforeAll(() => {
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
});

const app = require('../src/server');
const checkoutRouter = require('../src/routes/checkout');
const { signRequest: signAgentRequest } = require('../src/lib/agentSignature');
const { reserveSpend, checkVelocity } = require('../src/lib/velocityTracker');

function signBody(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function get(url) {
  return inject(app, { method: 'GET', url });
}

function post(url, { headers, body } = {}) {
  return inject(app, { method: 'POST', url, headers, body });
}

/** A distinct event id per run: dedup is persisted, so fixed ids are not idempotent. */
function eventId(tag) {
  return `evt_${tag}_${crypto.randomBytes(6).toString('hex')}`;
}

// ===================== ACP Discovery =====================

describe('GET /.well-known/acp.json', () => {
  test('returns 200 with ACP v2.0 manifest', async () => {
    const res = await get('/.well-known/acp.json');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('2.0');
    expect(res.body.supported_protocols).toContain('ACP-2.0');
    expect(res.body.supported_protocols).toContain('AP2');
    expect(res.body.checkout_lifecycle).toEqual([
      'CREATED', 'CONFIRMED', 'PAID', 'FULFILLING', 'COMPLETED',
    ]);
    expect(res.body.endpoints.products).toBe('/api/v1/products');
    expect(res.body.endpoints.checkout_sessions).toBe('/api/v1/checkout/sessions');
  });

  test('does not advertise the removed product feed', async () => {
    // Discovery is a contract: an agent reads this document and calls what it
    // finds. /api/v1/feed and its mock catalogue were deleted in favour of the
    // DB-backed products route, so leaving the entry here is a 404 the agent
    // cannot diagnose.
    const { endpoints } = (await get('/.well-known/acp.json')).body;
    expect(endpoints.feed).toBeUndefined();
    expect((await get('/api/v1/feed')).status).toBe(404);
    expect((await get(endpoints.products)).status).toBe(200);
  });
});

// ===================== Health Check =====================

describe('GET /health', () => {
  test('returns 200 with ok status', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ===================== Products =====================

describe('Products API', () => {
  test('GET /api/v1/products returns all products', async () => {
    const res = await get('/api/v1/products');
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.count).toBe(res.body.products.length);
  });

  test('GET /api/v1/products?category=audio filters by category', async () => {
    const res = await get('/api/v1/products?category=audio');
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeGreaterThan(0);
    // `category` is a filter input, not a response field: the row is deliberately
    // stripped to { sku, name, price_inr, stock } before it reaches the LLM, so
    // the filter is proved by which SKUs come back, not by echoing the category.
    const audioSkus = res.body.products.map((p) => p.sku);
    expect(audioSkus).toContain('sony-wh-1000xm5-wireless-noise-cancelling-headphones');
    for (const p of res.body.products) {
      expect(Object.keys(p).sort()).toEqual(['name', 'price_inr', 'sku', 'stock']);
    }
  });

  test('GET /api/v1/products?max_price=300000 filters by price', async () => {
    const res = await get('/api/v1/products?max_price=300000');
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeGreaterThan(0);
    res.body.products.forEach((p) => {
      expect(p.price_inr * 100).toBeLessThanOrEqual(300000);
    });
  });

  test('GET /api/v1/products caps the feed at 15 rows', async () => {
    const res = await get('/api/v1/products');
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeLessThanOrEqual(15);
  });

  test('GET /api/v1/products never leaks risk_tier / max_quantity / item_type', async () => {
    const res = await get('/api/v1/products');
    expect(res.status).toBe(200);
    for (const p of res.body.products) {
      expect(p).not.toHaveProperty('risk_tier');
      expect(p).not.toHaveProperty('max_quantity_per_order');
      expect(p).not.toHaveProperty('item_type');
    }
  });

  test('GET /api/v1/products/:sku returns a single product', async () => {
    const res = await get('/api/v1/products/groq-llama3-70b-1m');
    expect(res.status).toBe(200);
    expect(res.body.sku).toBe('groq-llama3-70b-1m');
    expect(res.body.id).toBe('groq-llama3-70b-1m');
    expect(Number.isInteger(res.body.price)).toBe(true);
  });

  test('GET /api/v1/products/:sku returns 404 for unknown SKU', async () => {
    const res = await get('/api/v1/products/prod_nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });
});

// ===================== Webhook =====================

describe('Webhook signature verification', () => {
  const headers = (sig) => ({
    'Content-Type': 'application/json',
    ...(sig ? { 'x-razorpay-signature': sig } : {}),
  });

  test('valid signature -> 200', async () => {
    const payload = JSON.stringify({
      event: 'payment.captured',
      id: eventId('captured'),
      payload: { payment: { entity: { id: 'pay_abc' } } },
    });
    const res = await post('/api/v1/webhooks/razorpay', {
      headers: headers(signBody(payload, SECRET)),
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  test('missing signature -> 400', async () => {
    const payload = JSON.stringify({ event: 'payment.captured', id: eventId('nosig') });
    const res = await post('/api/v1/webhooks/razorpay', { headers: headers(null), body: payload });
    expect(res.status).toBe(400);
  });

  test('tampered body -> 400', async () => {
    const payload = JSON.stringify({ event: 'payment.captured', id: eventId('tamper') });
    const sig = signBody(payload, SECRET);
    const res = await post('/api/v1/webhooks/razorpay', {
      headers: headers(sig),
      body: '{"event":"payment.captured","id":"tampered"}',
    });
    expect(res.status).toBe(400);
  });

  test('wrong signature -> 400', async () => {
    const payload = JSON.stringify({ event: 'payment.captured', id: eventId('wrongsig') });
    const res = await post('/api/v1/webhooks/razorpay', {
      headers: headers('deadbeef'),
      body: payload,
    });
    expect(res.status).toBe(400);
  });

  test('duplicate event id -> already_processed', async () => {
    const payload = JSON.stringify({
      event: 'order.paid',
      id: eventId('dedup'),
      payload: { order: { entity: { id: 'order_123' } } },
    });
    const sig = signBody(payload, SECRET);

    const first = await post('/api/v1/webhooks/razorpay', { headers: headers(sig), body: payload });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('success');

    const res = await post('/api/v1/webhooks/razorpay', { headers: headers(sig), body: payload });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_processed');
  });

  test('payment.failed resolves a persisted checkout and releases its pending velocity reservation', async () => {
    const sessionId = `acp_sess_webhook_${crypto.randomBytes(5).toString('hex')}`;
    const orderId = `order_webhook_${crypto.randomBytes(5).toString('hex')}`;
    const principalId = `usr_webhook_${crypto.randomBytes(5).toString('hex')}`;
    const reservationId = await reserveSpend(principalId, 100, 100, 60_000);
    checkoutRouter._sessions.set(sessionId, {
      sessionId,
      state: 'CONFIRMED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      razorpayOrderId: orderId,
      reservationId,
      reservationPrincipalId: principalId,
      failure: null,
    });

    // Deliberately omit notes.session_id: Razorpay payment events can be
    // correlated through their order id, and that lookup must survive restart.
    const payload = JSON.stringify({
      event: 'payment.failed', id: eventId('failed'),
      payload: { payment: { entity: {
        id: 'pay_failed_test', order_id: orderId,
        error_code: 'BAD_REQUEST_ERROR', error_description: 'Insufficient funds',
      } } },
    });
    const res = await post('/api/v1/webhooks/razorpay', {
      headers: headers(signBody(payload, SECRET)), body: payload,
    });

    expect(res.status).toBe(200);
    const persisted = checkoutRouter._sessions.get(sessionId);
    expect(persisted.state).toBe('FAILED');
    expect(persisted.failure).toMatchObject({ code: 'BAD_REQUEST_ERROR', payment_id: 'pay_failed_test' });
    expect(checkVelocity(principalId, 100, 100, 60_000).allowed).toBe(true);
  });
});

// ===================== Checkout idempotency =====================

describe('Checkout session lifecycle', () => {
  function signRequest(method, url, attestationObj, body = {}) {
    // Ed25519 agent signature (server verifies with AGENT_PUBLIC_KEY).
    return signAgentRequest({
      method,
      path: url,
      agentId: attestationObj.agent_id,
      principalId: attestationObj.principal_id,
      body,
      privateKey: process.env.AGENT_PRIVATE_KEY,
    });
  }

  test('POST /complete without Idempotency-Key -> 400', async () => {
    const attObj = { agent_id: 'test', principal_id: 'test' };
    const url = '/api/v1/checkout/sessions/fake_id/complete';
    const res = await post(url, {
      headers: {
        'X-Agorio-Attestation': Buffer.from(JSON.stringify(attObj)).toString('base64'),
        'X-Agorio-Signature': signRequest('POST', url, attObj, {})
      },
      body: {}
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_MISSING');
  });

  test('POST /complete with Idempotency-Key but fake session -> 404', async () => {
    const attObj = { agent_id: 'test', principal_id: 'test' };
    const url = '/api/v1/checkout/sessions/fake_id/complete';
    const res = await post(url, {
      headers: {
        'Idempotency-Key': 'idem_fake',
        'X-Agorio-Attestation': Buffer.from(JSON.stringify(attObj)).toString('base64'),
        'X-Agorio-Signature': signRequest('POST', url, attObj, {})
      },
      body: {},
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

// ===================== Direct Razorpay ingress is permanently retired =====================

describe('Orders ingress retirement', () => {
  test.each(['/api/v1/orders', '/api/v1/orders/link'])('%s -> 410 regardless of caller supplied money fields', async (url) => {
    const res = await post(url, { body: { amount: 749900, currency: 'USD', receipt: 'arbitrary' } });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('DIRECT_RAZORPAY_INGRESS_RETIRED');
  });
});
