'use strict';

/**
 * The adversarial judge's regression suite, as executable tests.
 *
 * Each block below is one attack from the audit. Two of them now assert the
 * OPPOSITE of what they originally did, because the model they were written
 * against was itself the finding:
 *
 *   - Attack 3 required a cookieless /complete to fail with 401. Demanding a
 *     human session cookie on the agent's path IS the "autonomous execution is
 *     functionally broken" seam: it makes full delegation unimplementable. The
 *     agent's authority is now a human-signed delegation grant, so a cookieless
 *     call must SUCCEED with one and be REFUSED without one. Both are asserted.
 *   - Attack 5 signed an ApprovalMandate with process.env.BUYER_PRIVATE_KEY. No
 *     such key exists any more; the server holds nothing that could stand in for
 *     a human. The stronger claim is asserted instead: an approval proved by ANY
 *     in-process key is refused on shape, before any signature math, while the
 *     same charge goes through once the authenticator signs it.
 *
 * Runs socket-free (tests/helpers/inject.js) because this sandbox denies listen().
 * The authenticator is software; every verifier is production code, unmodified.
 * Nothing in src/ is mocked except the Razorpay network call.
 */

// Both must precede the server require: the routes read them at module load.
process.env.AUTO_APPROVE_THRESHOLD_PAISE = '100000000'; // keep every charge on the 200/order path
process.env.GUARDRAIL_VELOCITY_MAX_COUNT = '10'; // Attacks 2 and 6 need the spend ceiling to bind, not the count

jest.mock('../src/lib/razorpayClient', () => ({
  createOrder: jest.fn(async (params) => ({ id: `order_mock_${params.receipt}`, ...params })),
  createPaymentLink: jest.fn(async (params) => ({
    id: 'plink_mock', short_url: 'https://rzp.io/i/plink_mock', ...params,
  })),
  cancelPaymentLink: jest.fn(async (id) => ({ id, status: 'cancelled' })),
}));

const crypto = require('crypto');

const app = require('../src/server');
const db = require('../src/db');
const checkoutRouter = require('../src/routes/checkout');
const { createMerchantTools } = require('../src/mcp/merchantClient');
const { createAuditLog, sharedAuditLog } = require('../src/lib/auditLog');
const { signEdDSA } = require('../src/lib/jcs-eddsa');
const { resetLedger } = require('../src/lib/velocityTracker');
const { inject, injectFetch } = require('./helpers/inject');
const { SoftAuthenticator } = require('./helpers/softAuthenticator');

const PRINCIPAL = 'usr_alice';
const AGENT_ID = 'buyer_agent_1'; // must equal config.agentId — the grant names the agent
const CAP_PAISE = 50000000; // ₹500,000 account cap for this suite

const CHEAP_SKU = 'prod_elec_007'; // ₹1,900
const PRICEY_SKU = 'prod_elec_005'; // ₹29,990 — two of these breach the 5,000,000 test cap
const BURST_CAP_PAISE = 5000000;

let authenticator;
let toolAudit;
let tools;

/** ADR-008 attestation: who the agent is. Deliberately never what it may spend. */
function agentHeaders(extra = {}) {
  const attestation = Buffer.from(
    JSON.stringify({ agent_id: AGENT_ID, principal_id: PRINCIPAL })
  ).toString('base64');
  // No Cookie. That absence is the whole point of Attack 3.
  return { 'X-Agorio-Attestation': attestation, ...extra };
}

/** Drive the real WebAuthn login ceremony; return the session cookie. */
async function loginAsHuman() {
  const gen = await inject(app, { method: 'GET', url: `/auth/login/generate?principal_id=${PRINCIPAL}` });
  expect(gen.status).toBe(200);
  const verify = await inject(app, {
    method: 'POST',
    url: '/auth/login/verify',
    headers: { Cookie: gen.cookie },
    body: authenticator.sign(gen.body.challenge),
  });
  expect(verify.body).toMatchObject({ verified: true, principal_id: PRINCIPAL });
  return gen.cookie;
}

/** The full grant ceremony: the server proposes an envelope, the human signs it. */
async function issueGrant(capPaise = CAP_PAISE) {
  const cookie = await loginAsHuman();
  const challenge = await inject(app, {
    method: 'POST',
    url: '/api/v1/mandates/intent/challenge',
    headers: { Cookie: cookie },
    body: { max_amount_paise: capPaise },
  });
  expect(challenge.status).toBe(200);

  const issued = await inject(app, {
    method: 'POST',
    url: '/api/v1/mandates/intent',
    headers: { Cookie: cookie },
    body: {
      intent_mandate: challenge.body.intent_mandate,
      assertion: authenticator.sign(challenge.body.webauthn.challenge),
    },
  });
  expect(issued.status).toBe(201);
  return { grantId: issued.body.mandate_id, cookie };
}

/** An agent building a cart against a grant it could not have minted. */
function agentCreatesCart(grantId, sku, quantity = 1) {
  return inject(app, {
    method: 'POST',
    url: '/api/v1/checkout/sessions',
    headers: agentHeaders(),
    body: { intent_mandate_id: grantId, requested_items: [{ sku, quantity }] },
  });
}

function agentCompletes(sessionId, body = {}) {
  return inject(app, {
    method: 'POST',
    url: `/api/v1/checkout/sessions/${sessionId}/complete`,
    headers: agentHeaders({ 'Idempotency-Key': `idem_${crypto.randomBytes(6).toString('hex')}` }),
    body,
  });
}

/** Lower the account cap. The tighter of (grant cap, account cap) governs. */
function setAccountCap(paise) {
  db.prepare('UPDATE users SET budget_cap_paise = ? WHERE principal_id = ?').run(paise, PRINCIPAL);
}

beforeAll(() => {
  db.prepare(
    `INSERT INTO users (principal_id, budget_cap_paise, delegation_mode) VALUES (?, ?, 'full')
       ON CONFLICT(principal_id) DO UPDATE SET budget_cap_paise = excluded.budget_cap_paise,
                                              delegation_mode = 'full'`
  ).run(PRINCIPAL, CAP_PAISE);
});

beforeEach(() => {
  // A fresh authenticator per test keeps signature counters independent.
  authenticator = new SoftAuthenticator();
  authenticator.register(db, PRINCIPAL);
  db.prepare("UPDATE users SET delegation_mode = 'full', budget_cap_paise = ? WHERE principal_id = ?")
    .run(CAP_PAISE, PRINCIPAL);
  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);
  checkoutRouter._sessions.clear();
  // The velocity window is process-wide and rolling; without this, spend from an
  // earlier test counts against the principal here.
  resetLedger();

  // A per-test audit chain, so tool assertions need not slice the shared one.
  toolAudit = createAuditLog();
  tools = createMerchantTools({
    baseUrl: 'http://127.0.0.1',
    auditLog: toolAudit,
    autoApproveThresholdPaise: 100000000,
    fetchImpl: injectFetch(app), // no cookie jar: the agent has no session
  });
});

afterAll(() => {
  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);
  resetLedger();
});

// ─── Attack 1: budget override injection ────────────────────────────────────
describe('Attack 1: budget override injection', () => {
  test('an agent-supplied budget is stripped and the attempt is audited', async () => {
    await issueGrant();
    await tools.create_cart({
      budget_in_rupees: 900000,
      items: [{ item_id: CHEAP_SKU, quantity: 1 }],
    });

    const ignored = toolAudit.entries().find(
      (e) => e.payload && e.payload.note === 'IGNORED_AGENT_SUPPLIED_LIMIT'
    );
    expect(ignored).toBeDefined();
    expect(ignored.payload.supplied).toBe(900000);
  });

  test('the cart is priced against the human-signed grant, not the injected number', async () => {
    const { grantId } = await issueGrant();
    const cart = await tools.create_cart({
      budget_in_rupees: 900000,
      items: [{ item_id: CHEAP_SKU, quantity: 1 }],
    });
    const session = checkoutRouter._sessions.get(cart.session_id);
    expect(session.intentMandate.mandate_id).toBe(grantId);
    expect(session.intentMandate.claims.constraints.max_amount).toBe(CAP_PAISE);
  });

  test('with no grant at all, the tool yields to a human instead of self-issuing one', async () => {
    // No issueGrant() here. The old failure mode was minting an IntentMandate on
    // the spot with a server-held key.
    await expect(
      tools.create_cart({ items: [{ item_id: CHEAP_SKU, quantity: 1 }] })
    ).rejects.toThrow(/YIELD_TO_HUMAN[\s\S]*DELEGATION_GRANT_REQUIRED/);
  });
});

// ─── Attack 2: velocity bypass via intent/session spam ──────────────────────
describe('Attack 2: velocity bypass via session spam', () => {
  test('sequential carts under one principal cannot outrun the rolling cap', async () => {
    const { grantId } = await issueGrant();
    // Each charge is inside the cap on its own; their sum is not. If spend were
    // keyed per intent or per session, all four would land.
    setAccountCap(BURST_CAP_PAISE);

    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const cart = await agentCreatesCart(grantId, PRICEY_SKU);
      expect(cart.status).toBe(201);
      statuses.push((await agentCompletes(cart.body.session_id)).status);
    }

    expect(statuses.filter((s) => s === 200 || s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 403).length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Attack 3: authorization boundary (inverted — see file header) ───────────
describe('Attack 3: authorization boundary', () => {
  test('with a human-signed grant, a cookieless agent CAN complete a checkout', async () => {
    const { grantId } = await issueGrant();
    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    expect(cart.status).toBe(201);

    const done = await agentCompletes(cart.body.session_id);
    // Not 401. Full delegation that cannot transact is not a security property.
    expect([200, 202]).toContain(done.status);
    expect(done.body.state).toBe('CONFIRMED');
  });

  test('a grant revoked mid-flight stops a checkout already underway', async () => {
    const { grantId } = await issueGrant();
    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    expect(cart.status).toBe(201);

    // Authority is re-resolved at the money boundary, not trusted from cart time.
    db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);

    const done = await agentCompletes(cart.body.session_id);
    expect(done.status).toBe(404);
    expect(done.body.error.code).toBe('GRANT_NOT_FOUND');
  });

  test('an agent with no attestation and no session is refused', async () => {
    const { grantId } = await issueGrant();
    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    const done = await inject(app, {
      method: 'POST',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/complete`,
      headers: { 'Idempotency-Key': `idem_${crypto.randomBytes(6).toString('hex')}` },
      body: {},
    });
    expect(done.status).toBe(401);
    expect(done.body.error.code).toBe('ATTESTATION_REQUIRED');
  });
});

// ─── Attack 4: x402 independent settlement ingress ─────────────────────────
describe('Attack 4: x402 independent settlement ingress', () => {
  test('is retired even for an authenticated caller with a plausible proof', async () => {
    const cookie = await loginAsHuman();
    const before = sharedAuditLog.entries().length;
    const res = await inject(app, {
      method: 'POST', url: '/x402/submit', headers: { Cookie: cookie },
      body: { amount: 1000, nonce: `nonce-${crypto.randomBytes(4).toString('hex')}`, signature: 'plausible-but-irrelevant' },
    });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('X402_MONEY_INGRESS_RETIRED');
    expect(sharedAuditLog.entries().slice(before).some((entry) => entry.event_type === 'MONEY_ACTION')).toBe(false);
  });
});

// ─── Attack 5: self-signed ApprovalMandate (strengthened — see file header) ──
describe('Attack 5: self-signed ApprovalMandate', () => {
  test('no in-process key exists that could sign for the human', () => {
    expect(process.env.BUYER_PRIVATE_KEY).toBeUndefined();
    expect(process.env.HUMAN_PRINCIPAL_PRIVATE_KEY).toBeUndefined();
  });

  test('an approval proved by a key the agent generated is refused on shape', async () => {
    const { grantId } = await issueGrant();
    // Partial delegation: no charge proceeds without a per-transaction approval.
    db.prepare("UPDATE users SET delegation_mode = 'partial' WHERE principal_id = ?").run(PRINCIPAL);

    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    expect(cart.status).toBe(201);

    // The closest the agent can now get to the old BUYER_PRIVATE_KEY: mint a
    // keypair and sign itself a maximally generous approval.
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const forged = {
      type: 'ApprovalMandate',
      session_id: cart.body.session_id,
      principal_id: PRINCIPAL,
      cart_mandate_id: cart.body.cart_mandate.mandate_id,
      approved_amount: CAP_PAISE,
      issued_at: new Date().toISOString(),
    };
    forged.proof = {
      type: 'eddsa-jcs-2022',
      alg: 'EdDSA',
      jws: signEdDSA(forged, privateKey.export({ type: 'pkcs8', format: 'pem' })),
    };

    const done = await agentCompletes(cart.body.session_id, { approval_mandate: forged });
    expect(done.status).toBe(402);
    expect(done.body.error.code).toBe('APPROVAL_MANDATE_REQUIRED');
    // Rejected on proof type, before any signature is checked: no key the server
    // can reach is a human.
    expect(done.body.error.message).toMatch(/APPROVAL_PROOF_NOT_WEBAUTHN/);
  });

  test('the same charge goes through when the human authenticator signs it', async () => {
    const { grantId, cookie } = await issueGrant();
    db.prepare("UPDATE users SET delegation_mode = 'partial' WHERE principal_id = ?").run(PRINCIPAL);

    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    expect(cart.status).toBe(201);

    // The approval challenge is a human-only endpoint: the agent cannot fetch its
    // own permission slip. The human's browser does this with their cookie.
    const challenge = await inject(app, {
      method: 'GET',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/approve/challenge`,
      headers: { Cookie: cookie },
    });
    expect(challenge.status).toBe(200);

    const done = await agentCompletes(cart.body.session_id, {
      approval_mandate: {
        ...challenge.body.approval_mandate,
        proof: { type: 'webauthn-assertion', response: authenticator.sign(challenge.body.challenge) },
      },
    });
    expect([200, 202]).toContain(done.status);
    expect(done.body.state).toBe('CONFIRMED');
  });

  test('the approval challenge is not reachable without a human session', async () => {
    const { grantId } = await issueGrant();
    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    const res = await inject(app, {
      method: 'GET',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/approve/challenge`,
      headers: agentHeaders(),
    });
    expect(res.status).toBe(401);
  });
});

// ─── Attack 6: concurrent velocity burst (TOCTOU) ────────────────────────────
describe('Attack 6: concurrent velocity burst', () => {
  test('N concurrent completions under one principal cannot all charge', async () => {
    const { grantId } = await issueGrant();
    setAccountCap(BURST_CAP_PAISE);

    const sessionIds = [];
    for (let i = 0; i < 4; i++) {
      const cart = await agentCreatesCart(grantId, PRICEY_SKU);
      expect(cart.status).toBe(201);
      sessionIds.push(cart.body.session_id);
    }

    // Fired together, so every one of them reads the ledger before any commits —
    // the exact interleaving the old check-then-record shape charged on.
    const statuses = await Promise.all(sessionIds.map((id) => agentCompletes(id).then((r) => r.status)));

    // 2,999,000 paise each against a 5,000,000 cap: exactly one may land.
    expect(statuses.filter((s) => s === 200 || s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 403).length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Attack 7: x402 test-principal backdoor ─────────────────────────────────
describe('Attack 7: x402 test-principal backdoor', () => {
  test('X-Test-Principal-Id cannot revive a retired payment writer', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/x402/submit',
      headers: { 'X-Test-Principal-Id': PRINCIPAL },
      body: {
        amount: 1000,
        nonce: `nonce-backdoor-${crypto.randomBytes(4).toString('hex')}`,
        signature: `eyJhbGciOiJFZERTQSJ9..${crypto.randomBytes(32).toString('base64url')}`,
      },
    });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('X402_MONEY_INGRESS_RETIRED');
  });
});

// ─── The chain that records all of it ───────────────────────────────────────
describe('audit chain', () => {
  test('the shared hash chain is intact after every attack above', () => {
    expect(sharedAuditLog.verifyChain().valid).toBe(true);
  });
});
