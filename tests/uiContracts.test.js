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
  it('returns { products:[...], count } with paise prices and the fields the feed reads', async () => {
    const { statusCode, body } = await get('/api/v1/products');
    expect(statusCode).toBe(200);
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.count).toBe(body.products.length);
    expect(body.products.length).toBeGreaterThan(0);

    const p = body.products[0];
    expect(typeof p.id).toBe('string');
    expect(typeof p.title).toBe('string');
    expect(typeof p.price).toBe('number'); // paise (amountPaiseOf reads this)
    expect(typeof p.currency).toBe('string');
    expect(typeof p.availability).toBe('boolean');
    expect(Array.isArray(p.images)).toBe(true);
    expect(p.eligibility).toEqual(expect.objectContaining({ agent_purchasable: true }));
  });

  it('honors the max_price (paise) filter', async () => {
    const { statusCode, body } = await get('/api/v1/products?max_price=200000');
    expect(statusCode).toBe(200);
    for (const p of body.products) expect(p.price).toBeLessThanOrEqual(200000);
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

  it('purchase within budget returns a confirmed receipt whose refId is a real money block on the chain', async () => {
    const before = (await get('/audit-log')).body.count;

    const { statusCode, body } = await post('/chat', {
      messages: [{ role: 'user', content: 'buy a mechanical keyboard' }],
      provider: 'stub',
      budget: 100000,
    });
    expect(statusCode).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    const receipt = body.find((m) => m.role === 'receipt');
    expect(receipt).toBeDefined();
    const d = receipt.data;
    // Fields the ReceiptCard renders (rupees, client-formatted).
    expect(d.status).toBe('confirmed');
    expect(typeof d.orderId).toBe('string');
    expect(typeof d.subtotal).toBe('number');
    expect(typeof d.tax).toBe('number');
    expect(typeof d.total).toBe('number');
    expect(Array.isArray(d.items)).toBe(true);
    expect(typeof d.refId).toBe('string');
    expect(d.refId.length).toBeGreaterThan(0);

    // The turn appended real blocks; the receipt's refId IS the money block hash
    // (the receipt chain-chip deep-links the Trust Center to exactly this block).
    const after = await get('/audit-log');
    expect(after.body.count).toBeGreaterThan(before);
    const moneyBlock = after.body.entries.find((e) => e.hash === d.refId);
    expect(moneyBlock).toBeDefined();
    expect(moneyBlock.event_type).toBe('MONEY_ACTION');
    // amountPaiseOf() reads amount_rupees*100 or amount_paise off this payload.
    expect(moneyBlock.payload.amount_rupees).toBe(d.total);
  });
});
