'use strict';

// Contract tests for the endpoints the Next "brutalist" UI binds to
// (lib/audit.ts, lib/chat.ts, and the audit-provider poller). They prove the
// server returns the exact shapes those clients destructure.
//
// Driven socket-free via app.handle() (tests/helpers/mockHttp.js) — supertest
// binds an ephemeral port, which this sandbox blocks. The Next UI proxies
// same-origin relative paths to these backend routes via next.config.ts
// rewrites, so the paths asserted here are the real targets:
//   GET  /api/v1/products      -> product feed (paise prices)
//   GET  /audit-log            -> { genesis_hash, count, integrity, entries }
//   POST /audit-log/verify     -> { valid, brokenAt }
//   POST /chat (stub path)     -> [agent, receipt] + real hash-linked money block

const { handle } = require('./helpers/mockHttp');

// The stub /chat path mints orders locally, but requiring the server wires the
// checkout router which constructs the Razorpay client; mock it so no route can
// reach the real API (mirrors checkout.test.js).
jest.mock('../src/lib/razorpayClient', () => ({
  createOrder: jest.fn(async (params) => ({ id: 'order_simulated_mock', ...params })),
  createPaymentLink: jest.fn(async (params) => ({ id: 'plink_simulated_mock', short_url: 'https://rzp.io/i/plink_simulated_mock', ...params })),
  cancelPaymentLink: jest.fn(async (id) => ({ id, status: 'cancelled' })),
}));

const app = require('../src/server');

const get = async (url) => {
  const res = await handle(app, { method: 'GET', url });
  return { statusCode: res.statusCode, body: JSON.parse(res.captured) };
};
const post = async (url, body) => {
  const res = await handle(app, {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.captured) };
};

describe('UI contract: GET /api/v1/products (product feed)', () => {
  it('returns { products:[...], count } with the narrow agent-facing fields only', async () => {
    const { statusCode, body } = await get('/api/v1/products');
    expect(statusCode).toBe(200);
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.count).toBe(body.products.length);
    expect(body.products.length).toBeGreaterThan(0);

    const p = body.products[0];
    expect(typeof p.sku).toBe('string');
    expect(typeof p.name).toBe('string');
    expect(typeof p.price_inr).toBe('number'); // rupees; the merchant prices carts in paise itself
    expect(typeof p.stock).toBe('number');

    // Token truncation: enforcement inputs and unused columns never reach the LLM.
    for (const field of ['risk_tier', 'max_quantity', 'max_quantity_per_order', 'item_type', 'description']) {
      expect(p).not.toHaveProperty(field);
    }
    expect(Object.keys(p).sort()).toEqual(['name', 'price_inr', 'sku', 'stock']);
  });

  it('caps the result set at 15 rows so a broad search cannot flood the context window', async () => {
    const { statusCode, body } = await get('/api/v1/products');
    expect(statusCode).toBe(200);
    expect(body.products.length).toBeLessThanOrEqual(15);
  });

  it('honors the max_price (paise) filter', async () => {
    const { statusCode, body } = await get('/api/v1/products?max_price=200000');
    expect(statusCode).toBe(200);
    for (const p of body.products) expect(p.price_inr * 100).toBeLessThanOrEqual(200000);
  });
});

describe('UI contract: GET /audit-log (audit-provider poll)', () => {
  it('returns { genesis_hash, count, integrity:{valid,brokenAt}, entries[] }', async () => {
    const { statusCode, body } = await get('/audit-log');
    expect(statusCode).toBe(200);
    expect(typeof body.genesis_hash).toBe('string');
    expect(typeof body.count).toBe('number');
    expect(body.integrity).toEqual(expect.objectContaining({ valid: expect.any(Boolean) }));
    expect('brokenAt' in body.integrity).toBe(true); // null or index
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.count).toBe(body.entries.length);
  });
});

describe('UI contract: POST /audit-log/verify (Trust Center Verify button)', () => {
  it('returns { valid:boolean, brokenAt }', async () => {
    const { statusCode, body } = await post('/audit-log/verify', {});
    expect(statusCode).toBe(200);
    expect(typeof body.valid).toBe('boolean');
    expect('brokenAt' in body).toBe(true);
  });
});

describe('UI contract: POST /chat (useChat -> agent + receipt bubbles)', () => {
  it('non-purchase message returns a single agent bubble with content', async () => {
    const { statusCode, body } = await post('/chat', {
      messages: [{ role: 'user', content: 'what can you do?' }],
      provider: 'stub',
      budget: 10000,
    });
    expect(statusCode).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].role).toBe('agent');
    expect(typeof body[0].content).toBe('string');
    expect(body[0].content.length).toBeGreaterThan(0);
  });

  it('safe-preview purchase returns no receipt and no fabricated money block', async () => {
    const before = (await get('/audit-log')).body.count;

    const { statusCode, body } = await post('/chat', {
      messages: [{ role: 'user', content: 'buy a mechanical keyboard' }],
      provider: 'stub',
      budget: 100000,
    });
    expect(statusCode).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    expect(body.find((m) => m.role === 'receipt')).toBeUndefined();
    expect(body[0].content).toMatch(/simulation is disabled/i);
    const after = await get('/audit-log');
    expect(after.body.count).toBeGreaterThan(before);
    const added = after.body.entries.slice(before);
    expect(added.map((entry) => entry.event_type)).toEqual(['AGENT_REASONING']);
    expect(added.some((entry) => entry.event_type === 'MONEY_ACTION')).toBe(false);
  });
});
