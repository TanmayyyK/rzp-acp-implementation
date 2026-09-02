'use strict';

/**
 * Checkout session lifecycle: create, update, read, complete, cancel, aliases.
 *
 * This suite used to drive the app with supertest (app.listen — EPERM in this
 * sandbox) and, more importantly, it was written against the authorization model
 * that the security audit rejected: every session was opened by POSTing a
 * self-made `intent_mandate` with `proof.jws: 'stub'`, and /complete was called
 * with a fabricated `connect.sid` cookie. Both of those ARE the findings — an
 * agent that can hand over its own IntentMandate is authorizing its own
 * spending. So the lifecycle assertions are kept and re-pointed at the real
 * model: a human signs a delegation grant with their authenticator, and the
 * agent references it by id.
 *
 * Runs socket-free over tests/helpers/inject.js.
 */

// Read at request time by /complete; keep every charge on the 200/order path
// unless a test deliberately lowers it.
process.env.AUTO_APPROVE_THRESHOLD_PAISE = '100000000';

jest.mock('../src/lib/razorpayClient', () => ({
  createOrder: jest.fn(async (params) => ({ id: 'order_simulated_mock', ...params })),
  createPaymentLink: jest.fn(async (params) => ({
    id: 'plink_simulated_mock', short_url: 'https://rzp.io/i/plink_simulated_mock', ...params,
  })),
  cancelPaymentLink: jest.fn(async (id) => ({ id, status: 'cancelled' })),
}));

const crypto = require('crypto');

const app = require('../src/server');
const db = require('../src/db');
const checkoutRouter = require('../src/routes/checkout');
const { signRequest: signAgentRequest } = require('../src/lib/agentSignature');
const { resetLedger } = require('../src/lib/velocityTracker');
const { sharedAuditLog: auditLog } = require('../src/lib/auditLog');
const { inject } = require('./helpers/inject');
const { SoftAuthenticator } = require('./helpers/softAuthenticator');

const PRINCIPAL = 'usr_alice';
const AGENT_ID = 'buyer_agent_1';
const CAP_PAISE = 50000000;

// Fixtures are named, then priced FROM the catalog rather than from a literal.
// The whole point of this suite is that the merchant is the pricing authority:
// hardcoding 179900 here would let a seed change silently drift the assertion
// away from what the server actually charges. Reading the price back is also the
// only honest way to assert "the total equals catalog price times quantity".
const EARBUDS = 'nothing-ear-a-wireless-earbuds';
const POWER_BANK = 'anker-737-power-bank-powercore-24k';
const OUT_OF_STOCK = 'apple-braided-usb-c-to-usb-c-cable-2m'; // forced unavailable in beforeAll

const catalogPaise = (sku) =>
  db.prepare('SELECT COALESCE(unit_price_paise, price_paise) AS p FROM products WHERE id = ? OR sku = ?')
    .get(sku, sku).p;

const EARBUDS_PAISE = catalogPaise(EARBUDS);
const POWER_BANK_PAISE = catalogPaise(POWER_BANK);

let authenticator;
let grantId;

// ─── Harness ────────────────────────────────────────────────────────────

function agentHeaders(method = 'GET', url = '/', body = null, extra = {}) {
  const attestationObj = { agent_id: AGENT_ID, principal_id: PRINCIPAL };
  const attestation = Buffer.from(JSON.stringify(attestationObj)).toString('base64');
  
  // Sign with the agent's Ed25519 private key; the server verifies with the
  // public half. `url` is the full path (originalUrl, incl. query) the server sees.
  const signatureHeader = signAgentRequest({
    method,
    path: url,
    agentId: attestationObj.agent_id,
    principalId: attestationObj.principal_id,
    body,
    privateKey: process.env.AGENT_PRIVATE_KEY,
  });

  return { 
    'X-Agorio-Attestation': attestation,
    'X-Agorio-Signature': signatureHeader,
    ...extra 
  };
}

function idempotencyKey() {
  return `idem_${crypto.randomBytes(6).toString('hex')}`;
}

function get(url, headers) {
  return inject(app, { method: 'GET', url, headers: headers || agentHeaders('GET', url) });
}

function post(url, body = {}, headers) {
  return inject(app, { method: 'POST', url, headers: headers || agentHeaders('POST', url, body), body });
}

function patch(url, body = {}, headers) {
  return inject(app, { method: 'PATCH', url, headers: headers || agentHeaders('PATCH', url, body), body });
}

/** The real ceremony: the server proposes a grant envelope, the human signs it. */
async function issueGrant() {
  const gen = await get(`/auth/login/generate?principal_id=${PRINCIPAL}`, {});
  const verify = await inject(app, {
    method: 'POST',
    url: '/auth/login/verify',
    headers: { Cookie: gen.cookie },
    body: authenticator.sign(gen.body.challenge),
  });
  expect(verify.body).toMatchObject({ verified: true });

  const challenge = await inject(app, {
    method: 'POST',
    url: '/api/v1/mandates/intent/challenge',
    headers: { Cookie: gen.cookie },
    body: { max_amount_paise: CAP_PAISE },
  });
  const issued = await inject(app, {
    method: 'POST',
    url: '/api/v1/mandates/intent',
    headers: { Cookie: gen.cookie },
    body: {
      intent_mandate: challenge.body.intent_mandate,
      assertion: authenticator.sign(challenge.body.webauthn.challenge),
    },
  });
  expect(issued.status).toBe(201);
  return issued.body.mandate_id;
}

function createSession(items = [{ sku: EARBUDS, quantity: 1 }]) {
  return post('/api/v1/checkout/sessions', { intent_mandate_id: grantId, requested_items: items });
}

function completeSession(sessionId, key = idempotencyKey(), body = {}) {
  const url = `/api/v1/checkout/sessions/${sessionId}/complete`;
  return post(url, body, agentHeaders('POST', url, body, { 'Idempotency-Key': key }));
}

function cancelSession(sessionId) {
  const url = `/api/v1/checkout/sessions/${sessionId}/cancel`;
  return post(url, {}, agentHeaders('POST', url, {}, { 'Idempotency-Key': idempotencyKey() }));
}

beforeAll(() => {
  db.prepare(
    `INSERT INTO users (principal_id, budget_cap_paise, delegation_mode) VALUES (?, ?, 'full')
       ON CONFLICT(principal_id) DO UPDATE SET budget_cap_paise = excluded.budget_cap_paise,
                                              delegation_mode = 'full'`
  ).run(PRINCIPAL, CAP_PAISE);
  // The seed ships nothing out of stock, so the PRODUCT_UNAVAILABLE branch needs
  // a row forced unavailable. Restored in afterAll so the catalogue other suites
  // read is unchanged.
  db.prepare('UPDATE products SET availability = 0 WHERE id = ?').run(OUT_OF_STOCK);
});

beforeEach(async () => {
  authenticator = new SoftAuthenticator();
  authenticator.register(db, PRINCIPAL);
  db.prepare("UPDATE users SET delegation_mode = 'full', budget_cap_paise = ? WHERE principal_id = ?")
    .run(CAP_PAISE, PRINCIPAL);
  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);
  checkoutRouter._sessions.clear();
  resetLedger(); // the rolling window is process-wide
  grantId = await issueGrant();
});

afterAll(() => {
  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);
  db.prepare('UPDATE products SET availability = 1 WHERE id = ?').run(OUT_OF_STOCK);
  resetLedger();
});

// ═══════════════════════════════════════════════════════════════════════
// 1. CREATE CHECKOUT SESSION
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/v1/checkout/sessions', () => {
  test('201 — creates session with correct schema', async () => {
    const res = await createSession();
    expect(res.status).toBe(201);
    expect(res.body.session_id).toMatch(/^acp_sess_/);
    expect(res.body.state).toBe('CREATED');
    expect(res.body.amount_total).toBe(EARBUDS_PAISE);
    expect(res.body.currency).toBe('INR');
    expect(res.body.expires_at).toBeDefined();

    // Shape-C CartMandate, minted by the merchant (the only party with prices).
    const cm = res.body.cart_mandate;
    expect(cm.mandate_id).toMatch(/^man_cart/);
    expect(cm.type).toBe('CartMandate');
    expect(cm.spec).toBe('ap2/0.1');
    expect(cm.session_id).toBe(res.body.session_id);
    expect(cm.proof.type).toBe('eddsa-jcs-2022');
    // The cart chains to the grant the human signed, not to anything the agent
    // supplied.
    expect(cm.prev_mandate_id).toBe(grantId);
    expect(cm.claims.intent_mandate_id).toBe(grantId);
  });

  test('400 — missing intent_mandate_id', async () => {
    const res = await post('/api/v1/checkout/sessions', {
      requested_items: [{ sku: EARBUDS, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MANDATE_MISSING');
  });

  test('400 — a caller-supplied intent_mandate is refused outright', async () => {
    // The old shape of this suite: an agent minting its own authority. Refused
    // loudly rather than ignored, so a stale caller learns why.
    const selfSigned = {
      mandate_id: 'mnd_intent_self_signed',
      type: 'IntentMandate',
      claims: { constraints: { max_amount: 99999999 } },
      proof: { type: 'Ed25519Signature2020', jws: 'stub' },
    };
    const items = [{ sku: EARBUDS, quantity: 1 }];

    const bare = await post('/api/v1/checkout/sessions', {
      intent_mandate: selfSigned,
      requested_items: items,
    });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('INTENT_MANDATE_NOT_ACCEPTED');

    // And it cannot ride along with a legitimate reference, where a lenient
    // handler might have read the grant for authorization and the mandate for
    // its limits.
    const smuggled = await post('/api/v1/checkout/sessions', {
      intent_mandate_id: grantId,
      intent_mandate: selfSigned,
      requested_items: items,
    });
    expect(smuggled.status).toBe(400);
    expect(smuggled.body.error.code).toBe('INTENT_MANDATE_NOT_ACCEPTED');
  });

  test('404 — intent_mandate_id that names no live grant', async () => {
    const res = await post('/api/v1/checkout/sessions', {
      intent_mandate_id: 'mnd_intent_does_not_exist',
      requested_items: [{ sku: EARBUDS, quantity: 1 }],
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('GRANT_NOT_FOUND');
  });

  test('400 — empty requested_items', async () => {
    const res = await createSession([]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ITEMS');
  });

  test('400 — product not found', async () => {
    const res = await createSession([{ sku: 'prod_nonexistent', quantity: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  test('400 — out of stock product', async () => {
    const res = await createSession([{ sku: OUT_OF_STOCK, quantity: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  test('multi-item session calculates total correctly', async () => {
    const res = await createSession([
      { sku: EARBUDS, quantity: 2 },
      { sku: POWER_BANK, quantity: 1 },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.amount_total).toBe(EARBUDS_PAISE * 2 + POWER_BANK_PAISE);
  });

  test('agent-supplied prices are stripped, not honoured, and the refusal is audited', async () => {
    // The hallucination case: a buyer agent asserts its own price. Only sku and
    // quantity are read; everything else is dropped before the total is computed,
    // so the charge is the catalog price no matter what the agent claimed.
    const before = auditLog.entries().length;

    const res = await createSession([
      {
        sku: EARBUDS,
        quantity: 1,
        price: 1,
        unit_price: 1,
        amount: 1,
        unit_price_paise: 1,
        currency: 'USD',
      },
    ]);

    expect(res.status).toBe(201);
    expect(res.body.amount_total).toBe(EARBUDS_PAISE); // not 1
    expect(res.body.currency).toBe('INR');

    // The cart the merchant signed carries its own price, not the agent's.
    const line = res.body.cart_mandate.claims.line_items[0];
    expect(line.unit_price).toBe(EARBUDS_PAISE);

    // The trail shows the fields were seen and refused, not silently ignored.
    const stripped = auditLog
      .entries()
      .slice(before)
      .find((e) => e.payload && e.payload.check === 'agent_supplied_pricing');
    expect(stripped).toBeDefined();
    expect(stripped.payload.outcome).toBe('STRIPPED');
    expect(stripped.payload.detail.note).toBe('IGNORED_AGENT_SUPPLIED_ITEM_FIELDS');
    expect(stripped.payload.detail.stripped.map((s) => s.field).sort()).toEqual(
      ['amount', 'currency', 'price', 'unit_price', 'unit_price_paise']
    );
    expect(auditLog.verifyChain().valid).toBe(true); // hash chain intact
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

    const res = await patch(`/api/v1/checkout/sessions/${sessionId}`, {
      requested_items: [{ sku: POWER_BANK, quantity: 1 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.state).toBe('CREATED');
    expect(res.body.amount_total).toBe(POWER_BANK_PAISE);
    expect(res.body.cart_mandate.mandate_id).not.toBe(oldMandateId);
    // A replacement cart chains to the grant, not to the cart it supersedes: the
    // AP2 chain records what authorized this cart, and the discarded cart
    // authorized nothing.
    expect(res.body.cart_mandate.prev_mandate_id).toBe(grantId);
  });

  test('404 — session not found', async () => {
    const res = await patch('/api/v1/checkout/sessions/acp_sess_nonexistent', {
      requested_items: [{ sku: EARBUDS, quantity: 1 }],
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  test('400 — empty requested_items on update', async () => {
    const created = await createSession();
    const res = await patch(`/api/v1/checkout/sessions/${created.body.session_id}`, {
      requested_items: [],
    });
    expect(res.status).toBe(400);
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

    const res = await get(`/api/v1/checkout/sessions/${sessionId}`);
    expect(res.status).toBe(200);

    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.state).toBe('CREATED');
    expect(res.body.order_id).toMatch(/^ord_/);
    expect(res.body.amount).toBe(EARBUDS_PAISE);
    expect(res.body.currency).toBe('INR');

    expect(res.body.line_items).toHaveLength(1);
    expect(res.body.line_items[0].sku).toBe(EARBUDS);
    expect(res.body.line_items[0].unit_price).toBe(EARBUDS_PAISE);

    expect(res.body.mandate_chain.intent_mandate_id).toBe(grantId);
    expect(res.body.mandate_chain.cart_mandate_id).toMatch(/^man_cart/);
    expect(res.body.mandate_chain.payment_mandate_id).toBeNull();

    expect(res.body.razorpay.order_id).toBeNull();
    expect(res.body.razorpay.payment_id).toBeNull();
    expect(res.body.razorpay.payment_link_id).toBeNull();

    expect(res.body.created_at).toBeDefined();
    expect(res.body.updated_at).toBeDefined();
    expect(res.body.failure).toBeNull();
  });

  test('404 — session not found', async () => {
    const res = await get('/api/v1/checkout/sessions/acp_sess_nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. COMPLETE CHECKOUT
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/v1/checkout/sessions/:id/complete', () => {
  test('400 — missing Idempotency-Key', async () => {
    const created = await createSession();
    const res = await post(`/api/v1/checkout/sessions/${created.body.session_id}/complete`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_MISSING');
  });

  test('200 — auto-approved (under threshold)', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    const res = await completeSession(sessionId);

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.state).toBe('CONFIRMED');
    expect(res.body.order.order_id).toMatch(/^ord_/);
    expect(res.body.order.razorpay_order_id).toMatch(/^order_simulated_/);
    // The PaymentMandate is minted and signed by the merchant, not supplied by
    // the caller — nothing in the request body can name it.
    expect(res.body.payment_mandate_id).toMatch(/^man_pay/);
    expect(res.body.next).toBe('await_webhook');
  });

  test('202 — escalated (over threshold)', async () => {
    const origThreshold = process.env.AUTO_APPROVE_THRESHOLD_PAISE;
    process.env.AUTO_APPROVE_THRESHOLD_PAISE = '100'; // ₹1
    try {
      const created = await createSession();
      const sessionId = created.body.session_id;

      const res = await completeSession(sessionId);

      expect(res.status).toBe(202);
      expect(res.body.session_id).toBe(sessionId);
      expect(res.body.state).toBe('CONFIRMED');
      expect(res.body.approval.type).toBe('payment_link');
      expect(res.body.approval.url).toMatch(/^https:\/\/rzp\.io\/i\//);
      expect(res.body.approval.payment_link_id).toMatch(/^plink_simulated_/);
      expect(res.body.next).toBe('await_human_then_webhook');
    } finally {
      if (origThreshold !== undefined) {
        process.env.AUTO_APPROVE_THRESHOLD_PAISE = origThreshold;
      } else {
        delete process.env.AUTO_APPROVE_THRESHOLD_PAISE;
      }
    }
  });

  test('409 — cannot complete twice with a different key', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    expect((await completeSession(sessionId)).status).toBe(200);

    const res = await completeSession(sessionId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  test('idempotent replay — same Idempotency-Key replays the original response, not a 409', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;
    const key = idempotencyKey();

    const first = await completeSession(sessionId, key);
    // Same key, replayed as if the original 200 was lost in transit.
    const retry = await completeSession(sessionId, key);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200); // must NOT 409 — this is the retry-safety guarantee
    expect(retry.body).toEqual(first.body); // verbatim replay of the original completion
  });

  test('session state is CONFIRMED after complete', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    const done = await completeSession(sessionId);
    expect(done.status).toBe(200);

    const state = await get(`/api/v1/checkout/sessions/${sessionId}`);
    expect(state.body.state).toBe('CONFIRMED');
    expect(state.body.mandate_chain.payment_mandate_id).toBe(done.body.payment_mandate_id);
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

    const res = await cancelSession(sessionId);

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.state).toBe('CANCELLED');
    expect(res.body.razorpay.order_id).toBeNull();
    expect(res.body.razorpay.status).toBe('not_created');
  });

  test('200 — cancels a CONFIRMED session (order created but unpaid)', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    expect((await completeSession(sessionId)).status).toBe(200);

    const res = await cancelSession(sessionId);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('CANCELLED');
    expect(res.body.razorpay.order_id).toMatch(/^order_simulated_/);
    expect(res.body.razorpay.status).toBe('cancelled');
  });

  test('409 — cannot cancel an already cancelled session', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    expect((await cancelSession(sessionId)).status).toBe(200);

    const res = await cancelSession(sessionId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CANCELLED');
  });

  test('404 — session not found', async () => {
    const res = await cancelSession('acp_sess_nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  test('session state is CANCELLED after cancel', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    expect((await cancelSession(sessionId)).status).toBe(200);

    const state = await get(`/api/v1/checkout/sessions/${sessionId}`);
    expect(state.body.state).toBe('CANCELLED');
  });

  test('cannot update a cancelled session', async () => {
    const created = await createSession();
    const sessionId = created.body.session_id;

    expect((await cancelSession(sessionId)).status).toBe(200);

    const res = await patch(`/api/v1/checkout/sessions/${sessionId}`, {
      requested_items: [{ sku: POWER_BANK, quantity: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SHORT ALIASES — /session
// ═══════════════════════════════════════════════════════════════════════

describe('short /session aliases', () => {
  test('POST /session creates a session with the schema shape', async () => {
    const res = await post('/session', {
      intent_mandate_id: grantId,
      requested_items: [{ sku: EARBUDS, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.session_id).toMatch(/^acp_sess_/);
    expect(res.body.state).toBe('CREATED');
    expect(res.body.cart_mandate.type).toBe('CartMandate');
    expect(res.body.amount_total).toBe(EARBUDS_PAISE);
    expect(res.body.currency).toBe('INR');
  });

  test('GET /session/:id, PATCH, complete, and cancel share the in-memory store', async () => {
    const created = await post('/session', {
      intent_mandate_id: grantId,
      requested_items: [{ sku: EARBUDS, quantity: 1 }],
    });
    const sessionId = created.body.session_id;

    const patched = await patch(`/session/${sessionId}`, {
      requested_items: [{ sku: POWER_BANK, quantity: 1 }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.amount_total).toBe(POWER_BANK_PAISE);

    const got = await get(`/session/${sessionId}`);
    expect(got.status).toBe(200);
    expect(got.body.amount).toBe(POWER_BANK_PAISE);
    expect(got.body.mandate_chain.cart_mandate_id).toBe(patched.body.cart_mandate.mandate_id);

    const completeUrl = `/session/${sessionId}/complete`;
    const completed = await post(completeUrl, {}, agentHeaders('POST', completeUrl, {}, { 'Idempotency-Key': idempotencyKey() }));
    expect(completed.status).toBe(200);
    expect(completed.body.next).toBe('await_webhook');
    expect(completed.body.order.razorpay_order_id).toMatch(/^order_simulated_/);

    const cancelUrl = `/session/${sessionId}/cancel`;
    const cancelled = await post(cancelUrl, {}, agentHeaders('POST', cancelUrl, {}, { 'Idempotency-Key': idempotencyKey() }));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('CANCELLED');
  });
});
