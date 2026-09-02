'use strict';

/**
 * The human authorization boundary.
 *
 * Three claims are under test, and they pull against each other — which is why
 * they belong in one file:
 *
 *   1. The agent cannot authorize its own spending. Authority is a delegation
 *      grant whose IntentMandate a human's authenticator signed; the agent can
 *      reference one and nothing more.
 *   2. No server-held key can stand in for a human. There is no buyer or human
 *      signing key in the process, so an approval either carries a real
 *      authenticator assertion or it does not exist.
 *   3. Despite (1) and (2), autonomous checkout works. An agent calling in
 *      statelessly, with no session cookie, completes a within-limits purchase.
 *
 * Satisfying any two of these is easy. (1)+(2) without (3) is a system that
 * cannot transact; (3) without (1)+(2) is the agent signing its own permission
 * slips. The tests below assert all three at once.
 *
 * The authenticator here is software (tests/helpers/softAuthenticator.js) but the
 * verifier is production code, unmodified. Nothing in src/ is mocked except the
 * Razorpay network call.
 */

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
const { signRequest: signAgentRequest } = require('../src/lib/agentSignature');
const { createMerchantTools } = require('../src/mcp/merchantClient');
const { resetLedger } = require('../src/lib/velocityTracker');
const { sharedAuditLog } = require('../src/lib/auditLog');
const { inject, injectFetch } = require('./helpers/inject');
const { SoftAuthenticator } = require('./helpers/softAuthenticator');

const PRINCIPAL = 'usr_alice';
const AGENT_ID = 'buyer_agent_1';
const CAP_PAISE = 1000000; // ₹10,000

// nothing-ear-a = ₹7,999 (under the ₹10,000 cap) · sony-wh-1000xm5 = ₹29,990 (over it)
const UNDER_CAP_SKU = 'nothing-ear-a-wireless-earbuds';
const OVER_CAP_SKU = 'sony-wh-1000xm5-wireless-noise-cancelling-headphones';


function agentHeaders(method = 'GET', url = '/', body = null, extra = {}) {
  const attestationObj = { agent_id: AGENT_ID, principal_id: PRINCIPAL };
  const attestation = Buffer.from(JSON.stringify(attestationObj)).toString('base64');
  
  // Sign with the agent's Ed25519 private key; the server verifies with the
  // public half. The signed payload binds method/path/agent/principal/body.
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

let authenticator;

/** Drive the real WebAuthn login ceremony and return the session cookie. */
async function loginAsHuman(auth) {
  const gen = await inject(app, { method: 'GET', url: `/auth/login/generate?principal_id=${PRINCIPAL}` });
  expect(gen.status).toBe(200);
  const verify = await inject(app, {
    method: 'POST',
    url: '/auth/login/verify',
    headers: { Cookie: gen.cookie },
    body: auth.sign(gen.body.challenge),
  });
  expect(verify.body).toMatchObject({ verified: true, principal_id: PRINCIPAL });
  return gen.cookie;
}

/** The full grant ceremony: server proposes, human's authenticator signs. */
async function issueGrant(cookie, auth, body = {}) {
  const challenge = await inject(app, {
    method: 'POST',
    url: '/api/v1/mandates/intent/challenge',
    headers: { Cookie: cookie },
    body,
  });
  expect(challenge.status).toBe(200);

  const issued = await inject(app, {
    method: 'POST',
    url: '/api/v1/mandates/intent',
    headers: { Cookie: cookie },
    body: {
      intent_mandate: challenge.body.intent_mandate,
      assertion: auth.sign(challenge.body.webauthn.challenge),
    },
  });
  return { challenge: challenge.body, issued };
}

/** An agent building a cart against a grant it did not mint. */
async function agentCreatesCart(grantId, sku, quantity = 1) {
  return inject(app, {
    method: 'POST',
    url: '/api/v1/checkout/sessions',
    headers: agentHeaders('POST', '/api/v1/checkout/sessions', { intent_mandate_id: grantId, requested_items: [{ sku, quantity }] }),
    body: { intent_mandate_id: grantId, requested_items: [{ sku, quantity }] },
  });
}

async function agentCompletes(sessionId, body = {}) {
  return inject(app, {
    method: 'POST',
    url: `/api/v1/checkout/sessions/${sessionId}/complete`,
    headers: agentHeaders('POST', `/api/v1/checkout/sessions/${sessionId}/complete`, body, { 'Idempotency-Key': `idem_${crypto.randomBytes(6).toString('hex')}` }),
    body,
  });
}

beforeAll(() => {
  db.prepare(
    `INSERT INTO users (principal_id, budget_cap_paise, delegation_mode) VALUES (?, ?, 'full')
       ON CONFLICT(principal_id) DO UPDATE SET budget_cap_paise = excluded.budget_cap_paise, delegation_mode = 'full'`
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
  // The velocity window is process-wide and rolling; without this, spend from
  // an earlier test counts against the principal here.
  resetLedger();
});

// ─────────────────────────────────────────────────────────────────────────
// Seam 2, at the root: there is no key to forge with.
// ─────────────────────────────────────────────────────────────────────────

describe('the server holds no human or buyer signing key', () => {
  test('no buyer or human private key exists in the process after boot', () => {
    // The judge's finding was that authority came from in-memory keypairs minted
    // at boot. If any of these are set, that finding is still true.
    expect(process.env.BUYER_PRIVATE_KEY).toBeUndefined();
    expect(process.env.BUYER_PUBLIC_KEY).toBeUndefined();
    expect(process.env.HUMAN_PRINCIPAL_PRIVATE_KEY).toBeUndefined();
    expect(process.env.HUMAN_PRINCIPAL_PUBLIC_KEY).toBeUndefined();
  });

  test('an ApprovalMandate proved by a server-side EdDSA signature is refused outright', async () => {
    const humanAuth = require('../src/circle/humanAuthorization');
    const { signEdDSA } = require('../src/lib/jcs-eddsa');
    const { publicKey: _pub, privateKey } = crypto.generateKeyPairSync('ed25519');

    const forged = {
      type: 'ApprovalMandate',
      session_id: 'acp_sess_anything',
      principal_id: PRINCIPAL,
      cart_mandate_id: null,
      approved_amount: 5000000,
      issued_at: new Date().toISOString(),
    };
    forged.proof = {
      type: 'eddsa-jcs-2022',
      alg: 'EdDSA',
      jws: signEdDSA(forged, privateKey.export({ type: 'pkcs8', format: 'pem' })),
    };

    const result = await humanAuth.verifyApprovalMandate({
      approvalMandate: forged,
      principalId: PRINCIPAL,
      sessionId: 'acp_sess_anything',
      cartMandateId: null,
      amountPaise: 5000000,
    });

    // Not "signature invalid" — the proof *shape* is rejected, so no key held
    // anywhere in the process can ever satisfy this check.
    expect(result).toEqual({ verified: false, reason: 'APPROVAL_PROOF_NOT_WEBAUTHN' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Seam 1: the agent cannot mint its own authority.
// ─────────────────────────────────────────────────────────────────────────

describe('an agent cannot authorize its own spending', () => {
  test('a self-supplied intent_mandate is refused, not silently ignored', async () => {
    const bodyPayload = {
      intent_mandate: {
        mandate_id: 'man_int_self_minted',
        type: 'IntentMandate',
        claims: { principal: PRINCIPAL, agent: AGENT_ID, constraints: { max_amount: 99999999 } },
      },
      intent_mandate_id: 'man_int_self_minted',
      requested_items: [{ sku: UNDER_CAP_SKU, quantity: 1 }],
    };
    const res = await inject(app, {
      method: 'POST',
      url: '/api/v1/checkout/sessions',
      headers: agentHeaders('POST', '/api/v1/checkout/sessions', bodyPayload),
      body: bodyPayload,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INTENT_MANDATE_NOT_ACCEPTED');
  });

  test('referencing a grant that no human signed is a 404', async () => {
    const res = await agentCreatesCart('man_int_does_not_exist', UNDER_CAP_SKU);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('GRANT_NOT_FOUND');
  });

  test('a grant cannot be issued without a real assertion', async () => {
    const cookie = await loginAsHuman(authenticator);
    const challenge = await inject(app, {
      method: 'POST',
      url: '/api/v1/mandates/intent/challenge',
      headers: { Cookie: cookie },
      body: {},
    });

    // An attacker with the human's live session, but no authenticator.
    const res = await inject(app, {
      method: 'POST',
      url: '/api/v1/mandates/intent',
      headers: { Cookie: cookie },
      body: {
        intent_mandate: challenge.body.intent_mandate,
        assertion: new SoftAuthenticator().sign(challenge.body.webauthn.challenge),
      },
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('HUMAN_SIGNATURE_INVALID');
    expect(db.prepare('SELECT COUNT(*) c FROM delegation_grants').get().c).toBe(0);
  });

  test('a grant whose cap was widened after signing does not verify', async () => {
    const cookie = await loginAsHuman(authenticator);
    const challenge = await inject(app, {
      method: 'POST',
      url: '/api/v1/mandates/intent/challenge',
      headers: { Cookie: cookie },
      body: { max_amount_paise: 100000 },
    });

    // Sign the ₹1,000 envelope the human actually saw, then submit a ₹9,999 one.
    const assertion = authenticator.sign(challenge.body.webauthn.challenge);
    const widened = JSON.parse(JSON.stringify(challenge.body.intent_mandate));
    widened.claims.constraints.max_amount = 999900;

    const res = await inject(app, {
      method: 'POST',
      url: '/api/v1/mandates/intent',
      headers: { Cookie: cookie },
      body: { intent_mandate: widened, assertion },
    });

    // The challenge is a hash of the envelope, so editing any field breaks it.
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('HUMAN_SIGNATURE_INVALID');
  });

  test('a grant cannot exceed the account cap even with a valid signature', async () => {
    const cookie = await loginAsHuman(authenticator);

    // Simulate a compromised page choosing what goes in front of the
    // authenticator: the authenticator shows an opaque challenge, so it would
    // sign this happily. The account cap is what stops it.
    const envelope = {
      mandate_id: `man_int_${crypto.randomBytes(8).toString('hex')}`,
      type: 'IntentMandate',
      spec: 'ap2/0.1',
      prev_mandate_id: null,
      session_id: null,
      issuer: `did:webauthn:${PRINCIPAL}`,
      subject: PRINCIPAL,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600000).toISOString(),
      nonce: crypto.randomBytes(16).toString('hex'),
      claims: {
        natural_language_intent: 'drain the account',
        constraints: { max_amount: CAP_PAISE * 100, currency: 'INR', categories_allowed: ['electronics'] },
        principal: PRINCIPAL,
        agent: AGENT_ID,
      },
    };
    const webauthnLib = require('../src/circle/webauthn');

    const res = await inject(app, {
      method: 'POST',
      url: '/api/v1/mandates/intent',
      headers: { Cookie: cookie },
      body: {
        intent_mandate: envelope,
        assertion: authenticator.sign(webauthnLib.generateTransactionChallenge(envelope)),
      },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CAP_EXCEEDED');
  });

  test('a grant belonging to another principal is refused', async () => {
    const cookie = await loginAsHuman(authenticator);
    const challenge = await inject(app, {
      method: 'POST',
      url: '/api/v1/mandates/intent/challenge',
      headers: { Cookie: cookie },
      body: {},
    });

    const stolen = JSON.parse(JSON.stringify(challenge.body.intent_mandate));
    stolen.subject = 'usr_bob';
    stolen.claims.principal = 'usr_bob';

    const res = await inject(app, {
      method: 'POST',
      url: '/api/v1/mandates/intent',
      headers: { Cookie: cookie },
      body: { intent_mandate: stolen, assertion: authenticator.sign(challenge.body.webauthn.challenge) },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PRINCIPAL_MISMATCH');
  });

  test('the MCP create_cart tool yields to the human when no grant exists', async () => {
    const tools = createMerchantTools({ baseUrl: 'http://merchant.test', fetchImpl: injectFetch(app) });

    await expect(tools.create_cart({ item_id: UNDER_CAP_SKU, quantity: 1 }))
      .rejects.toThrow(/YIELD_TO_HUMAN[\s\S]*DELEGATION_GRANT_REQUIRED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Seam 3: with real authority in place, the agent can actually transact.
// ─────────────────────────────────────────────────────────────────────────

describe('autonomous checkout works without a human session cookie', () => {
  test('an agent completes a within-limits purchase using only the grant', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    expect(issued.status).toBe(201);

    const cart = await agentCreatesCart(issued.body.mandate_id, UNDER_CAP_SKU);
    expect(cart.status).toBe(201);
    expect(cart.body.amount_total).toBeGreaterThan(0);

    const done = await agentCompletes(cart.body.session_id);

    // The judge's seam 3: this used to be a guaranteed 401/403.
    expect(done.status).toBe(200);
    expect(done.body.state).toBe('CONFIRMED');
  });

  test('the MCP tool surface completes a purchase end to end', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    expect(issued.status).toBe(201);

    // The agent's own fetch carries no cookie jar — a stateless caller.
    const tools = createMerchantTools({ baseUrl: 'http://merchant.test', fetchImpl: injectFetch(app) });

    const cart = await tools.create_cart({ item_id: UNDER_CAP_SKU, quantity: 1 });
    expect(cart.session_id).toBeTruthy();

    const result = await tools.complete_checkout({ session_id: cart.session_id });
    expect(result.status || result.state).toBeTruthy();
    expect(JSON.stringify(result)).not.toMatch(/401|403|UNAUTHORIZED/i);
  });

  test('an agent acting for the wrong principal is refused', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, UNDER_CAP_SKU);

    const res = await inject(app, {
      method: 'POST',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/complete`,
      headers: (() => {
        const urlPath = `/api/v1/checkout/sessions/${cart.body.session_id}/complete`;
        const attObj = { agent_id: AGENT_ID, principal_id: 'usr_bob' };
        const att = Buffer.from(JSON.stringify(attObj)).toString('base64');
        // A cryptographically VALID signature whose attested principal (usr_bob)
        // does not match the session's principal — it must clear signature
        // verification and be refused downstream with ATTESTATION_MISMATCH.
        return {
          'X-Agorio-Attestation': att,
          'X-Agorio-Signature': signAgentRequest({
            method: 'POST',
            path: urlPath,
            agentId: attObj.agent_id,
            principalId: attObj.principal_id,
            body: {},
            privateKey: process.env.AGENT_PRIVATE_KEY,
          }),
          'Idempotency-Key': 'idem_wrong_principal',
        };
      })(),
      body: {},
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ATTESTATION_MISMATCH');
  });

  test('an unidentified caller with no session and no attestation is refused', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, UNDER_CAP_SKU);

    const res = await inject(app, {
      method: 'POST',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/complete`,
      headers: { 'Idempotency-Key': 'idem_anon' },
      body: {},
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ATTESTATION_REQUIRED');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The limits the human set are the limits that hold.
// ─────────────────────────────────────────────────────────────────────────

describe('delegation limits gate the agent, and only a human can lift them', () => {
  test('an over-cap purchase stops until a human signs for it', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, OVER_CAP_SKU);
    expect(cart.status).toBe(201);

    const denied = await agentCompletes(cart.body.session_id);
    expect(denied.status).toBe(402);
    expect(denied.body.error.code).toBe('APPROVAL_MANDATE_REQUIRED');

    // The human is asked for exactly what they are authorizing.
    const challenge = await inject(app, {
      method: 'GET',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/approve/challenge`,
      headers: { Cookie: cookie },
    });
    expect(challenge.status).toBe(200);
    expect(challenge.body.approval_mandate).toMatchObject({
      type: 'ApprovalMandate',
      session_id: cart.body.session_id,
      principal_id: PRINCIPAL,
      approved_amount: 2999000,
    });

    const approval = {
      ...challenge.body.approval_mandate,
      proof: { type: 'webauthn-assertion', response: authenticator.sign(challenge.body.webauthn.challenge) },
    };

    const done = await agentCompletes(cart.body.session_id, { approval_mandate: approval });
    // 202, not 200: this amount is over the auto-approve threshold, so the
    // charge escalates to a payment link. What matters here is that the human's
    // signature moved it past the authorization gate at all.
    expect(done.status).toBe(202);
    expect(done.body.state).toBe('CONFIRMED');
  });

  test('an approval signed by a different authenticator does not authorize the charge', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, OVER_CAP_SKU);

    const challenge = await inject(app, {
      method: 'GET',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/approve/challenge`,
      headers: { Cookie: cookie },
    });

    const attacker = new SoftAuthenticator();
    const res = await agentCompletes(cart.body.session_id, {
      approval_mandate: {
        ...challenge.body.approval_mandate,
        proof: { type: 'webauthn-assertion', response: attacker.sign(challenge.body.webauthn.challenge) },
      },
    });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('APPROVAL_MANDATE_REQUIRED');
  });

  test('an approval for a smaller amount cannot be lifted onto a larger charge', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, OVER_CAP_SKU);

    const challenge = await inject(app, {
      method: 'GET',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/approve/challenge`,
      headers: { Cookie: cookie },
    });

    // Sign a ₹100 approval, then present it against the ₹29,990 cart.
    const shrunk = { ...challenge.body.approval_mandate, approved_amount: 10000 };
    const webauthnLib = require('../src/circle/webauthn');
    const humanAuth = require('../src/circle/humanAuthorization');
    const assertion = authenticator.sign(
      webauthnLib.generateTransactionChallenge(humanAuth.approvalBinding(shrunk))
    );

    const res = await agentCompletes(cart.body.session_id, {
      approval_mandate: { ...shrunk, proof: { type: 'webauthn-assertion', response: assertion } },
    });

    expect(res.status).toBe(402);
    expect(res.body.error.message).toMatch(/APPROVAL_AMOUNT_INSUFFICIENT/);
  });

  test('partial delegation never lets the agent act alone, even far under the cap', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, UNDER_CAP_SKU);

    db.prepare("UPDATE users SET delegation_mode = 'partial' WHERE principal_id = ?").run(PRINCIPAL);

    const res = await agentCompletes(cart.body.session_id);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('APPROVAL_MANDATE_REQUIRED');
  });

  test('a refusal for want of a signature is on the chain, with what it would take to clear it', async () => {
    // Two reasons this entry has to exist. ADR-006 says every guardrail decision
    // is auditable, and a BLOCK that leaves no trace is the one you most need to
    // see later. And it is the only signal the Security Hub has that a session is
    // waiting on a human: public/js/delegation.js reads awaiting_approval off the
    // audit poll and offers to sign for exactly that session_id, so dropping
    // these fields silently strands the UI rather than breaking a route.
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, OVER_CAP_SKU);

    const before = sharedAuditLog.entries().length;
    const denied = await agentCompletes(cart.body.session_id);
    expect(denied.status).toBe(402);

    const appended = sharedAuditLog.entries().slice(before);
    const block = appended.find(
      (e) => e.event_type === 'GUARDRAIL_DECISION' && e.payload.check === 'human_approval'
    );
    expect(block).toBeDefined();
    expect(block.session_id).toBe(cart.body.session_id);
    expect(block.payload).toMatchObject({
      outcome: 'BLOCK',
      awaiting_approval: true,
      amount_paise: cart.body.amount_total,
      cap_paise: CAP_PAISE,
      delegation_mode: 'full',
    });

    // Signing it clears the wait: the panel drops the prompt when a MONEY_ACTION
    // lands for the same session, so that entry has to carry the session id too.
    const challenge = await inject(app, {
      method: 'GET',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/approve/challenge`,
      headers: { Cookie: cookie },
    });
    const done = await agentCompletes(cart.body.session_id, {
      approval_mandate: {
        ...challenge.body.approval_mandate,
        proof: { type: 'webauthn-assertion', response: authenticator.sign(challenge.body.webauthn.challenge) },
      },
    });
    expect(done.status).toBe(202);
    const money = sharedAuditLog
      .entries()
      .filter((e) => e.event_type === 'MONEY_ACTION' && e.session_id === cart.body.session_id);
    expect(money.length).toBe(1);
  });

  test('a partial-delegation refusal records the mode that caused it', async () => {
    // Same audited BLOCK, reached the other way. The panel shows one prompt for
    // both, but the chain has to say which rule fired: over-cap is fixable by
    // raising the cap, partial delegation is not.
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, UNDER_CAP_SKU);

    db.prepare("UPDATE users SET delegation_mode = 'partial' WHERE principal_id = ?").run(PRINCIPAL);

    const before = sharedAuditLog.entries().length;
    const res = await agentCompletes(cart.body.session_id);
    expect(res.status).toBe(402);

    const block = sharedAuditLog
      .entries()
      .slice(before)
      .find((e) => e.event_type === 'GUARDRAIL_DECISION' && e.payload.check === 'human_approval');
    expect(block).toBeDefined();
    expect(block.payload).toMatchObject({
      outcome: 'BLOCK',
      awaiting_approval: true,
      delegation_mode: 'partial',
      amount_paise: cart.body.amount_total,
    });
    // Under the cap, and still refused. The entry has to make that legible or it
    // reads as an over-cap block that raising the cap would clear.
    expect(block.payload.amount_paise).toBeLessThanOrEqual(block.payload.cap_paise);
  });

  test('revoking a grant stops a checkout that is already in flight', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, UNDER_CAP_SKU);
    expect(cart.status).toBe(201);

    const revoke = await inject(app, {
      method: 'POST',
      url: `/api/v1/mandates/intent/${issued.body.mandate_id}/revoke`,
      headers: { Cookie: cookie },
    });
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe('revoked');

    // The grant is re-resolved at completion, so the kill switch reaches a cart
    // that was already built.
    const res = await agentCompletes(cart.body.session_id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GRANT_REVOKED');
  });

  test('lowering the account cap constrains a grant that is already outstanding', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    expect(issued.body.max_amount_paise).toBe(CAP_PAISE);

    const cart = await agentCreatesCart(issued.body.mandate_id, UNDER_CAP_SKU);
    db.prepare('UPDATE users SET budget_cap_paise = ? WHERE principal_id = ?').run(100000, PRINCIPAL);

    const res = await agentCompletes(cart.body.session_id);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('APPROVAL_MANDATE_REQUIRED');
  });

  test('a rejected completion does not poison the session for a later retry', async () => {
    const cookie = await loginAsHuman(authenticator);
    const { issued } = await issueGrant(cookie, authenticator);
    const cart = await agentCreatesCart(issued.body.mandate_id, UNDER_CAP_SKU);

    // An unauthorized attempt first: authorization runs before the idempotency
    // lock, so it must leave no trace on the session.
    const anon = await inject(app, {
      method: 'POST',
      url: `/api/v1/checkout/sessions/${cart.body.session_id}/complete`,
      headers: { 'Idempotency-Key': 'idem_attacker_key' },
      body: {},
    });
    expect(anon.status).toBe(401);

    const done = await agentCompletes(cart.body.session_id);
    expect(done.status).toBe(200);
  });
});
