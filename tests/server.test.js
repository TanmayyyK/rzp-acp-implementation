'use strict';

const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/server');

const SECRET = 'test_webhook_secret_123';

// Set the env var before requiring the app (config reads it once)
beforeAll(() => {
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
});

function signBody(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ===================== ACP Discovery =====================

describe('GET /.well-known/acp.json', () => {
  test('returns 200 with ACP v2.0 manifest', async () => {
    const res = await request(app).get('/.well-known/acp.json');
    expect(res.statusCode).toBe(200);
    expect(res.body.version).toBe('2.0');
    expect(res.body.supported_protocols).toContain('ACP-2.0');
    expect(res.body.supported_protocols).toContain('AP2');
    expect(res.body.checkout_lifecycle).toEqual([
      'CREATED', 'CONFIRMED', 'PAID', 'FULFILLING', 'COMPLETED',
    ]);
  });
});

// ===================== Health Check =====================

describe('GET /health', () => {
  test('returns 200 with ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ===================== Products =====================

describe('Products API', () => {
  test('GET /api/v1/products returns all products', async () => {
    const res = await request(app).get('/api/v1/products');
    expect(res.statusCode).toBe(200);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.count).toBe(res.body.products.length);
  });

  test('GET /api/v1/products?category=audio filters by category', async () => {
    const res = await request(app).get('/api/v1/products?category=audio');
    expect(res.statusCode).toBe(200);
    res.body.products.forEach((p) => {
      expect(p.category).toBe('audio');
    });
  });

  test('GET /api/v1/products?max_price=300000 filters by price', async () => {
    const res = await request(app).get('/api/v1/products?max_price=300000');
    expect(res.statusCode).toBe(200);
    res.body.products.forEach((p) => {
      expect(p.price).toBeLessThanOrEqual(300000);
    });
  });

  test('GET /api/v1/products/:sku returns a single product', async () => {
    const res = await request(app).get('/api/v1/products/SKU-AUDIO-001');
    expect(res.statusCode).toBe(200);
    expect(res.body.sku).toBe('SKU-AUDIO-001');
  });

  test('GET /api/v1/products/:sku returns 404 for unknown SKU', async () => {
    const res = await request(app).get('/api/v1/products/SKU-NONEXISTENT');
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });
});

// ===================== Webhook =====================

describe('Webhook signature verification', () => {
  const PAYLOAD_STR = '{"event":"payment.captured","id":"evt_test_001","payload":{"payment":{"entity":{"id":"pay_abc"}}}}';

  test('valid signature → 200', async () => {
    const sig = signBody(PAYLOAD_STR, SECRET);
    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(PAYLOAD_STR);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('success');
  });

  test('missing signature → 400', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .send(PAYLOAD_STR);
    expect(res.statusCode).toBe(400);
  });

  test('tampered body → 400', async () => {
    const sig = signBody(PAYLOAD_STR, SECRET);
    const tampered = '{"event":"payment.captured","id":"tampered"}';
    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(tampered);
    expect(res.statusCode).toBe(400);
  });

  test('wrong signature → 400', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'deadbeef')
      .send(PAYLOAD_STR);
    expect(res.statusCode).toBe(400);
  });

  test('duplicate event id → already_processed', async () => {
    const payload2 = '{"event":"order.paid","id":"evt_test_dedup","payload":{"order":{"entity":{"id":"order_123"}}}}';
    const sig = signBody(payload2, SECRET);

    // First call
    await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(payload2);

    // Second call — same event id
    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(payload2);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('already_processed');
  });
});

// ===================== Checkout idempotency =====================

describe('Checkout session lifecycle', () => {
  test('POST /complete without idempotency-key → 400', async () => {
    const res = await request(app)
      .post('/api/v1/checkout/sessions/fake_id/complete')
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_MISSING');
  });

  test('POST /complete with idempotency-key but fake session → 404', async () => {
    const res = await request(app)
      .post('/api/v1/checkout/sessions/fake_id/complete')
      .set('Idempotency-Key', 'idem_test_001')
      .send({});
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

// ===================== Orders (validation only, no live Razorpay) =====================

describe('Orders validation', () => {
  test('POST /api/v1/orders without amount → 400', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .send({ receipt: 'ord_test_001' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
  });

  test('POST /api/v1/orders with float amount → 400', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .send({ amount: 749.99, receipt: 'ord_test_002' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
  });

  test('POST /api/v1/orders without receipt → 400', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .send({ amount: 749900 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('MISSING_RECEIPT');
  });

  test('POST /api/v1/orders/link without description → 400', async () => {
    const res = await request(app)
      .post('/api/v1/orders/link')
      .send({ amount: 749900 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('MISSING_DESCRIPTION');
  });
});
