'use strict';

/**
 * End-to-end merchant checkout flow verifier (ACP v2.0).
 *
 *   Step A  GET  /feed              → pick an available product
 *   Step B  POST /session          → initialise a cart
 *   Step C  PATCH /session/:id      → update quantities
 *   Step D  GET  /session/:id       → verify cart state + pricing totals
 *   Step E  POST /session/:id/complete (unique Idempotency-Key)
 *           → assert a real Razorpay Order id is minted and returned with 200
 *   Step F  POST /session/:id/complete (SAME key) → assert idempotent replay
 *
 * Run it in one line:
 *
 *     npm run test:e2e
 *
 * ── Why this is socket-free and Razorpay-mocked ──────────────────────────
 * The build sandbox cannot bind listening sockets (app.listen → EPERM) and
 * has no outbound route to api.razorpay.com. So instead of HTTP we drive the
 * Express app in-process via `app.handle(req, res)` with mock req/res objects,
 * and we swap the Razorpay client for a deterministic stub via the require
 * cache (mirroring `order_simulated_mock` used by the Jest suite). Every layer
 * under test — the /session alias router, ACP schema shaping, pricing,
 * idempotency wrapper, and the /complete state machine — is exercised for
 * real; only the outbound Razorpay HTTP call is faked. In a networked env,
 * delete the mock block and the same flow hits live Razorpay test keys.
 */

const http = require('http');
const path = require('path');

// ── Env: dummy Razorpay creds so nothing throws at require time ───────────
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_e2e';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'e2e_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'e2e_whsec';

// ── Inject a deterministic Razorpay client stub into the require cache ─────
// checkout.js does `require('../lib/razorpayClient')` lazily inside the
// handler, so pre-seeding the cache here guarantees it resolves to the stub.
const rzpClientPath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'razorpayClient.js'));
require.cache[rzpClientPath] = {
  id: rzpClientPath,
  filename: rzpClientPath,
  loaded: true,
  exports: {
    createOrder: async (params) => ({
      id: 'order_simulated_mock',
      entity: 'order',
      status: 'created',
      ...params,
    }),
    createPaymentLink: async (params) => ({
      id: 'plink_simulated_mock',
      short_url: 'https://rzp.io/i/plink_simulated_mock',
      status: 'created',
      ...params,
    }),
    cancelPaymentLink: async (id) => ({ id, status: 'cancelled' }),
    fetchOrder: async (id) => ({ id, status: 'created' }),
  },
};

// Require the app AFTER the stub is in place. server.js only calls
// app.listen() when run directly (require.main === module), so importing it
// here yields the bare Express app with no socket bind.
const app = require(path.join(__dirname, '..', 'src', 'server.js'));

// ── Minimal in-process HTTP driver (no sockets) ───────────────────────────
function inject(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null);
    req.method = method;
    req.url = url;

    const lowerHeaders = {};
    for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
    req.headers = { 'content-type': 'application/json', ...lowerHeaders };

    if (body !== undefined) {
      // Pre-parse the body and mark it so body-parser (express.json) skips it —
      // there is no readable stream to consume in this synthetic request.
      req.body = body;
      req._body = true;
    }

    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      return true;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      resolve({ statusCode: res.statusCode, body: parsed });
    };

    app.handle(req, res, (err) => {
      if (err) reject(err);
    });
  });
}

// ── Tiny assertion harness ────────────────────────────────────────────────
let passed = 0;
function assert(cond, msg, detail) {
  if (!cond) {
    console.error(`\n  ✗ FAIL: ${msg}`);
    if (detail !== undefined) console.error('    got:', JSON.stringify(detail, null, 2));
    throw new Error(`Assertion failed: ${msg}`);
  }
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

// ── Mandate stubs (schema-valid; signed for real on later days) ───────────
function intentMandate() {
  return {
    type: 'IntentMandate',
    mandate_id: 'mnd_intent_e2e',
    claims: { max_amount: 1000000, currency: 'INR' },
  };
}
function paymentMandate(amount) {
  return {
    type: 'PaymentMandate',
    mandate_id: 'mnd_payment_e2e',
    claims: { authorized_amount: amount, currency: 'INR' },
  };
}

async function main() {
  console.log('\n═══ ACP end-to-end checkout flow ═══\n');

  // ── Step A: GET /feed, pick an available product ─────────────────────────
  console.log('Step A — GET /feed');
  const feed = await inject('GET', '/feed');
  assert(feed.statusCode === 200, 'feed responds 200', feed);
  assert(Array.isArray(feed.body.products) && feed.body.products.length > 0, 'feed returns products');
  const product = feed.body.products.find((p) => p.availability === true);
  assert(!!product, 'at least one product is available');
  assert(typeof product.price === 'number' && product.price > 0, 'product price is a positive integer (paise)', product.price);
  console.log(`    → picked ${product.id} @ ${product.price} paise (₹${product.price / 100})`);

  // ── Step B: POST /session, initialise cart with qty 1 ────────────────────
  console.log('\nStep B — POST /session (init cart, qty 1)');
  const create = await inject('POST', '/session', {
    body: { intent_mandate: intentMandate(), requested_items: [{ sku: product.id, quantity: 1 }] },
  });
  assert(create.statusCode === 201, 'session created (201)', create);
  const sessionId = create.body.session_id;
  assert(typeof sessionId === 'string' && sessionId.startsWith('acp_sess_'), 'session_id minted', sessionId);
  assert(create.body.state === 'CREATED', 'initial state is CREATED', create.body.state);
  assert(create.body.amount_total === product.price, 'qty 1 total equals unit price', create.body.amount_total);
  assert(create.body.cart_mandate && create.body.cart_mandate.type === 'CartMandate', 'CartMandate issued');
  console.log(`    → session ${sessionId}`);

  // ── Step C: PATCH /session/:id, bump quantity to 2 ───────────────────────
  console.log('\nStep C — PATCH /session/:id (qty → 2)');
  const patch = await inject('PATCH', `/session/${sessionId}`, {
    body: { requested_items: [{ sku: product.id, quantity: 2 }] },
  });
  assert(patch.statusCode === 200, 'session updated (200)', patch);
  const expectedTotal = product.price * 2;
  assert(patch.body.amount_total === expectedTotal, 'qty 2 total = unit price × 2', patch.body.amount_total);

  // ── Step D: GET /session/:id, verify state + pricing ─────────────────────
  console.log('\nStep D — GET /session/:id (verify cart + pricing)');
  const get = await inject('GET', `/session/${sessionId}`);
  assert(get.statusCode === 200, 'session fetched (200)', get);
  assert(get.body.state === 'CREATED', 'state still CREATED pre-complete', get.body.state);
  assert(get.body.amount === expectedTotal, 'stored amount matches patched total', get.body.amount);
  assert(Array.isArray(get.body.line_items) && get.body.line_items.length === 1, 'one line item present');
  const li = get.body.line_items[0];
  assert(li.quantity === 2, 'line item quantity is 2', li.quantity);
  const lineSum = get.body.line_items.reduce((s, x) => s + x.unit_price * x.quantity, 0);
  assert(lineSum === get.body.amount, 'Σ(unit_price × qty) reconciles with amount', { lineSum, amount: get.body.amount });

  // ── Step E: POST /complete with a unique Idempotency-Key ─────────────────
  console.log('\nStep E — POST /session/:id/complete (unique Idempotency-Key)');
  const idemKey = `idem_e2e_${Date.now()}`;
  const complete = await inject('POST', `/session/${sessionId}/complete`, {
    headers: { 'Idempotency-Key': idemKey },
    body: { payment_mandate: paymentMandate(expectedTotal) },
  });
  assert(complete.statusCode === 200, 'complete responds 200 (auto-approved order path)', complete);
  assert(complete.body.state === 'CONFIRMED', 'state → CONFIRMED', complete.body.state);
  assert(!!complete.body.order, 'order object returned', complete.body);
  const rzpOrderId = complete.body.order.razorpay_order_id;
  assert(typeof rzpOrderId === 'string' && /^order_/.test(rzpOrderId), 'a valid Razorpay Order id is returned', rzpOrderId);
  assert(complete.body.next === 'await_webhook', 'next step is await_webhook', complete.body.next);
  console.log(`    → Razorpay order ${rzpOrderId}`);

  // ── Step F: retry SAME key → idempotent replay, not a 409 ────────────────
  console.log('\nStep F — POST /complete retry (same key → idempotent replay)');
  const replay = await inject('POST', `/session/${sessionId}/complete`, {
    headers: { 'Idempotency-Key': idemKey },
    body: { payment_mandate: paymentMandate(expectedTotal) },
  });
  assert(replay.statusCode === 200, 'retry replays 200 (not 409)', replay);
  assert(
    JSON.stringify(replay.body) === JSON.stringify(complete.body),
    'retry body is byte-identical to the original completion',
    replay.body
  );

  console.log(`\n═══ PASSED — ${passed} assertions, full A→F flow green ═══\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n═══ E2E FLOW FAILED ═══');
    console.error(err.message || err);
    process.exit(1);
  });
