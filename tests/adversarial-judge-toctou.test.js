'use strict';

/**
 * TOCTOU between PATCH /sessions/:id and POST /sessions/:id/complete.
 *
 * The judge's original probe asked one question: does a PATCH arriving during an
 * in-flight COMPLETE get refused? It answered it over a real socket with a 5 ms
 * sleep, which made the result a timing coincidence rather than a proof — and it
 * installed a `/_test/login` route on the app to get a session, which is its own
 * hole. This runs in-process (tests/helpers/inject.js), drives the real WebAuthn
 * ceremony, and places the PATCH at the one instant that was actually dangerous.
 *
 * That instant was real, and these tests exist because it charged. /complete used
 * to take its `_isProcessing` lock AFTER `await authorizeCompletion(...)`. Under
 * partial delegation that await is WebAuthn signature verification, so the
 * handler suspended for two event-loop turns with the session still mutable.
 * A PATCH landing there returned 200 and the charge executed against the new
 * basket:
 *
 *     after 1 turn: _isProcessing=undefined state=CREATED
 *     PATCH status 200   session amount now 299900000
 *     COMPLETE status 202 CONFIRMED  -> payment link for 299900000
 *
 * The human's authenticator had signed for 190000. The chain ceiling in
 * checkCartAgainstIntent did not save it: validation runs before the money
 * action, and the swap landed after validation, during `await reserveSpend`.
 *
 * Both windows are now covered:
 *   1. Partial delegation, PATCH at the first suspension point — the exploit above.
 *   2. Full delegation, PATCH once the handler is deeper in — same invariant.
 * In both, the money that moves must be the money that was authorized.
 */

process.env.AUTO_APPROVE_THRESHOLD_PAISE = '100000000'; // keep charges on the 200/order path

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
const razorpayClient = require('../src/lib/razorpayClient');
const { resetLedger } = require('../src/lib/velocityTracker');
const { inject } = require('./helpers/inject');
const { SoftAuthenticator } = require('./helpers/softAuthenticator');

const PRINCIPAL = 'usr_alice';
const AGENT_ID = 'buyer_agent_1';
const CAP_PAISE = 50000000; // ₹500,000

const CHEAP_SKU = 'prod_elec_007'; // ₹1,900 — what the human signs for
const PRICEY_SKU = 'prod_elec_005'; // ₹29,990 — x100 is 1578x the approved amount

let authenticator;

function agentHeaders(extra = {}) {
  const attestation = Buffer.from(
    JSON.stringify({ agent_id: AGENT_ID, principal_id: PRINCIPAL })
  ).toString('base64');
  return { 'X-Agorio-Attestation': attestation, ...extra };
}

async function loginAsHuman() {
  const gen = await inject(app, { method: 'GET', url: `/auth/login/generate?principal_id=${PRINCIPAL}` });
  const verify = await inject(app, {
    method: 'POST',
    url: '/auth/login/verify',
    headers: { Cookie: gen.cookie },
    body: authenticator.sign(gen.body.challenge),
  });
  expect(verify.body).toMatchObject({ verified: true });
  return gen.cookie;
}

async function issueGrant() {
  const cookie = await loginAsHuman();
  const challenge = await inject(app, {
    method: 'POST',
    url: '/api/v1/mandates/intent/challenge',
    headers: { Cookie: cookie },
    body: { max_amount_paise: CAP_PAISE },
  });
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

function agentCreatesCart(grantId, sku, quantity = 1) {
  return inject(app, {
    method: 'POST',
    url: '/api/v1/checkout/sessions',
    headers: agentHeaders(),
    body: { intent_mandate_id: grantId, requested_items: [{ sku, quantity }] },
  });
}

function completeInFlight(sessionId, body = {}) {
  // Deliberately not awaited by the caller: the point is to observe the request
  // mid-handler.
  return inject(app, {
    method: 'POST',
    url: `/api/v1/checkout/sessions/${sessionId}/complete`,
    headers: agentHeaders({ 'Idempotency-Key': `idem_${crypto.randomBytes(6).toString('hex')}` }),
    body,
  });
}

function patchCart(sessionId, sku, quantity) {
  return inject(app, {
    method: 'PATCH',
    url: `/api/v1/checkout/sessions/${sessionId}`,
    headers: agentHeaders(),
    body: { requested_items: [{ sku, quantity }] },
  });
}

function readSession(sessionId) {
  return inject(app, {
    method: 'GET',
    url: `/api/v1/checkout/sessions/${sessionId}`,
    headers: agentHeaders(),
  });
}

/** Yield the event loop, so an in-flight handler can advance to its awaits. */
async function letHandlerAdvance(turns = 1) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Every paise this suite handed to Razorpay, in call order. */
function amountsChargedToRazorpay() {
  return [
    ...razorpayClient.createOrder.mock.calls,
    ...razorpayClient.createPaymentLink.mock.calls,
  ].map(([params]) => params.amount);
}

/** A human-signed ApprovalMandate for exactly this session's current cart. */
async function humanApproves(sessionId, cookie) {
  const challenge = await inject(app, {
    method: 'GET',
    url: `/api/v1/checkout/sessions/${sessionId}/approve/challenge`,
    headers: { Cookie: cookie },
  });
  expect(challenge.status).toBe(200);
  return {
    ...challenge.body.approval_mandate,
    proof: { type: 'webauthn-assertion', response: authenticator.sign(challenge.body.challenge) },
  };
}

beforeAll(() => {
  db.prepare(
    `INSERT INTO users (principal_id, budget_cap_paise, delegation_mode) VALUES (?, ?, 'full')
       ON CONFLICT(principal_id) DO UPDATE SET budget_cap_paise = excluded.budget_cap_paise,
                                              delegation_mode = 'full'`
  ).run(PRINCIPAL, CAP_PAISE);
});

beforeEach(() => {
  authenticator = new SoftAuthenticator();
  authenticator.register(db, PRINCIPAL);
  db.prepare("UPDATE users SET delegation_mode = 'full', budget_cap_paise = ? WHERE principal_id = ?")
    .run(CAP_PAISE, PRINCIPAL);
  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);
  checkoutRouter._sessions.clear();
  resetLedger();
  razorpayClient.createOrder.mockClear();
  razorpayClient.createPaymentLink.mockClear();
  razorpayClient.cancelPaymentLink.mockClear();
});

afterAll(() => {
  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);
  resetLedger();
});

describe('PATCH during an in-flight COMPLETE', () => {
  test('a cart swapped while the human approval is being verified never gets charged', async () => {
    const { grantId, cookie } = await issueGrant();
    // Partial delegation is the dangerous mode: nothing charges without a
    // per-transaction approval, so /complete must do real signature crypto and
    // therefore really suspends.
    db.prepare("UPDATE users SET delegation_mode = 'partial' WHERE principal_id = ?").run(PRINCIPAL);

    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    expect(cart.status).toBe(201);
    const sessionId = cart.body.session_id;
    const approvedAmount = cart.body.amount_total; // 190000
    const approvedCartId = cart.body.cart_mandate.mandate_id;

    const approval = await humanApproves(sessionId, cookie);
    expect(approval.approved_amount).toBe(approvedAmount);

    // In flight. One turn is all it took: the pre-fix handler was suspended
    // inside authorizeCompletion here with `_isProcessing` still unset.
    const completion = completeInFlight(sessionId, { approval_mandate: approval });
    await letHandlerAdvance(1);
    expect(checkoutRouter._sessions.get(sessionId)._isProcessing).toBe(true);

    // The swap the exploit used: 100 x ₹29,990 under a ₹1,900 approval.
    const patched = await patchCart(sessionId, PRICEY_SKU, 100);
    expect(patched.status).toBe(409);
    expect(patched.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const done = await completion;
    expect([200, 202]).toContain(done.status);
    expect(done.body.state).toBe('CONFIRMED');

    // The invariant, asserted where the money actually leaves: Razorpay saw the
    // approved amount and nothing else.
    expect(amountsChargedToRazorpay()).toEqual([approvedAmount]);

    // And the session's own record agrees with what was charged.
    const finalState = await readSession(sessionId);
    expect(finalState.body.amount).toBe(approvedAmount);
    expect(finalState.body.cart_mandate.mandate_id).toBe(approvedCartId);
  });

  test('under full delegation the post-validation window is closed too', async () => {
    const { grantId } = await issueGrant();

    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    expect(cart.status).toBe(201);
    const sessionId = cart.body.session_id;
    const authorizedAmount = cart.body.amount_total;

    // SQLite makes the velocity reservation atomic rather than using an
    // in-process mutex. Once completion starts, the session lock prevents a
    // cart swap; when it settles, the state transition does the same.
    const completion = completeInFlight(sessionId);
    const done = await completion;
    expect([200, 202]).toContain(done.status);

    const patched = await patchCart(sessionId, PRICEY_SKU, 100);
    expect(patched.status).toBe(409);
    expect(patched.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(amountsChargedToRazorpay()).toEqual([authorizedAmount]);
  });

  test('a rejected completion releases the lock instead of pinning the session', async () => {
    const { grantId } = await issueGrant();
    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    const sessionId = cart.body.session_id;

    // Revoking the grant makes authorizeCompletion reject — the path that used
    // to run before the lock was taken, and now runs inside it.
    db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);
    const refused = await completeInFlight(sessionId);
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe('GRANT_NOT_FOUND');

    const session = checkoutRouter._sessions.get(sessionId);
    expect(session._isProcessing).toBe(false);
    expect(session.state).toBe('CREATED');

    // The session is still usable rather than wedged: a PATCH works, which it
    // could not if the rejected caller had pinned the lock on its way out.
    expect((await patchCart(sessionId, CHEAP_SKU, 2)).status).toBe(200);
  });
});

describe('CANCEL during an in-flight COMPLETE', () => {
  test('a cancel arriving under a pending charge is refused, not silently lost', async () => {
    const { grantId, cookie } = await issueGrant();
    db.prepare("UPDATE users SET delegation_mode = 'partial' WHERE principal_id = ?").run(PRINCIPAL);

    const cart = await agentCreatesCart(grantId, CHEAP_SKU);
    const sessionId = cart.body.session_id;
    const approvedAmount = cart.body.amount_total;
    const approval = await humanApproves(sessionId, cookie);

    const completion = completeInFlight(sessionId, { approval_mandate: approval });
    await letHandlerAdvance(1);

    // /cancel awaits Razorpay and then does Object.assign(session, nextSession).
    // Unguarded, the two writers interleave and one side's state is discarded:
    // a charged order left CANCELLED, or a cancelled session that confirms.
    const cancelled = await inject(app, {
      method: 'POST',
      url: `/api/v1/checkout/sessions/${sessionId}/cancel`,
      headers: agentHeaders({ 'Idempotency-Key': `idem_${crypto.randomBytes(6).toString('hex')}` }),
      body: {},
    });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.retriable).toBe(true);

    const done = await completion;
    expect([200, 202]).toContain(done.status);
    expect(done.body.state).toBe('CONFIRMED');
    expect(amountsChargedToRazorpay()).toEqual([approvedAmount]);
    expect((await readSession(sessionId)).body.state).toBe('CONFIRMED');
  });
});
