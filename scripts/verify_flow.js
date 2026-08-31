'use strict';

/**
 * End-to-end verifier for the agentic checkout flow (ACP v2.0 + AP2).
 *
 *     npm run test:e2e
 *
 * ── What this proves ──────────────────────────────────────────────────────
 * Three claims that pull against each other. Any two are easy; the point is
 * that all three hold at once:
 *
 *   1. The agent cannot authorize its own spending. Authority is a delegation
 *      grant whose IntentMandate a human's authenticator signed. The agent may
 *      reference one by id and nothing else — a self-supplied IntentMandate is
 *      refused, not ignored.
 *   2. No server-held key stands in for a human. There is no buyer key and no
 *      human key in this process. An approval either carries a real WebAuthn
 *      assertion over the exact fields being approved, or it does not exist.
 *   3. Despite (1) and (2), autonomous checkout works. The agent calls in
 *      statelessly — no session cookie, only an attestation header — and
 *      completes a within-limits purchase.
 *
 * The authenticator here is software (tests/helpers/softAuthenticator.js),
 * standing in for the passkey in a phone's secure enclave. It is the *client*
 * side of the ceremony: its Ed25519 private key never leaves this process, and
 * the verifier it talks to is production code, unmodified. Swap in a real
 * passkey and nothing in src/ changes. That is the difference between a
 * client-side signer and a mock: the server holds no signing key either way.
 *
 * ── Why it is socket-free and Razorpay-mocked ────────────────────────────
 * The build sandbox cannot bind listening sockets (app.listen -> EPERM) and has
 * no route to api.razorpay.com. So the Express app is driven in-process through
 * the same injector the Jest suites use, and the Razorpay client is swapped for
 * a deterministic stub via the require cache. Every layer under test — WebAuthn
 * verification, grant resolution, mandate chain validation, guardrails, the
 * velocity ledger, idempotency, and the /complete state machine — runs for
 * real. Only the outbound Razorpay HTTP call is faked.
 */

const path = require('path');

// ── Env: dummy Razorpay creds so nothing throws at require time ───────────
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_e2e';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'e2e_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'e2e_whsec';
// Charges at or under this go straight to a Razorpay Order (200); above it they
// escalate to a payment link (202). Pinned so both paths are demonstrated.
process.env.AUTO_APPROVE_THRESHOLD_PAISE = '1000000'; // ₹10,000

// ── Inject a deterministic Razorpay client stub into the require cache ─────
// checkout.js requires '../lib/razorpayClient' lazily inside the handler, so
// pre-seeding the cache here guarantees it resolves to the stub.
const rzpClientPath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'razorpayClient.js'));
require.cache[rzpClientPath] = {
  id: rzpClientPath,
  filename: rzpClientPath,
  loaded: true,
  exports: {
    createOrder: async (params) => ({ id: 'order_simulated_mock', entity: 'order', status: 'created', ...params }),
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

// Require the app AFTER the stub is in place. server.js only calls app.listen()
// when run directly (require.main === module), so importing it yields the bare
// Express app with no socket bind.
const app = require(path.join(__dirname, '..', 'src', 'server.js'));
const db = require(path.join(__dirname, '..', 'src', 'db.js'));
const { resetLedger } = require(path.join(__dirname, '..', 'src', 'lib', 'velocityTracker.js'));
// The in-process HTTP driver and the soft authenticator are the Jest helpers.
// Reused rather than reimplemented: a second driver here would be a second
// thing to keep honest, and the cookie handling is exactly what the human
// ceremony needs.
const { inject } = require(path.join(__dirname, '..', 'tests', 'helpers', 'inject.js'));
const { SoftAuthenticator } = require(path.join(__dirname, '..', 'tests', 'helpers', 'softAuthenticator.js'));

const PRINCIPAL = 'usr_alice';
const AGENT_ID = 'buyer_agent_1';
const GRANT_CAP_PAISE = 1000000; // ₹10,000 — the ceiling the human signs for

const UNDER_CAP_SKU = 'prod_elec_001'; // ₹2,499
const OVER_CAP_SKU = 'prod_elec_005'; // ₹29,990

let authenticator;

// ── Tiny assertion harness ────────────────────────────────────────────────
let passed = 0;
function assert(cond, msg, detail) {
  if (!cond) {
    console.error(`\n  x FAIL: ${msg}`);
    if (detail !== undefined) console.error('    got:', JSON.stringify(detail, null, 2));
    throw new Error(`Assertion failed: ${msg}`);
  }
  passed += 1;
  console.log(`  + ${msg}`);
}

function idempotencyKey() {
  return `idem_e2e_${require('crypto').randomBytes(6).toString('hex')}`;
}

/** ADR-008 attestation: who is calling. Deliberately not what they may do. */
function agentHeaders(extra = {}) {
  const attestation = Buffer.from(
    JSON.stringify({ agent_id: AGENT_ID, principal_id: PRINCIPAL })
  ).toString('base64');
  // No Cookie. Its absence is the point of claim (3).
  return { 'X-Agorio-Attestation': attestation, ...extra };
}

const get = (url, headers = agentHeaders()) => inject(app, { method: 'GET', url, headers });
const post = (url, body = {}, headers = agentHeaders()) => inject(app, { method: 'POST', url, headers, body });
const patch = (url, body = {}, headers = agentHeaders()) => inject(app, { method: 'PATCH', url, headers, body });

/**
 * Each numbered scenario below is an independent demonstration, but they share
 * one process — and the velocity ledger's rolling window is process-wide. Reset
 * it between scenarios, exactly as the Jest suites do per test, so scenario N
 * is not throttled by scenario N-1's spend.
 */
function newScenario(title) {
  resetLedger();
  console.log(`\n${title}`);
}

/** The real WebAuthn login ceremony. Returns the session cookie. */
async function loginAsHuman() {
  const gen = await get(`/auth/login/generate?principal_id=${PRINCIPAL}`, {});
  assert(gen.status === 200, 'login challenge issued', gen.body);
  const verify = await inject(app, {
    method: 'POST',
    url: '/auth/login/verify',
    headers: { Cookie: gen.cookie },
    body: authenticator.sign(gen.body.challenge),
  });
  assert(verify.body.verified === true, 'authenticator assertion verified server-side', verify.body);
  return gen.cookie;
}

/** The server proposes a grant envelope; the human's authenticator signs it. */
async function issueGrant(cookie) {
  const challenge = await inject(app, {
    method: 'POST',
    url: '/api/v1/mandates/intent/challenge',
    headers: { Cookie: cookie },
    body: { max_amount_paise: GRANT_CAP_PAISE },
  });
  assert(challenge.status === 200, 'grant envelope proposed for signing', challenge.body);
  assert(
    challenge.body.intent_mandate.claims.constraints.max_amount === GRANT_CAP_PAISE,
    'the envelope names the exact cap the human is signing for',
    challenge.body.intent_mandate.claims.constraints
  );

  const issued = await inject(app, {
    method: 'POST',
    url: '/api/v1/mandates/intent',
    headers: { Cookie: cookie },
    body: {
      intent_mandate: challenge.body.intent_mandate,
      assertion: authenticator.sign(challenge.body.webauthn.challenge),
    },
  });
  assert(issued.status === 201, 'delegation grant persisted (201)', issued.body);
  return issued.body.mandate_id;
}

function agentCreatesCart(grantId, sku, quantity = 1) {
  return post('/api/v1/checkout/sessions', {
    intent_mandate_id: grantId,
    requested_items: [{ sku, quantity }],
  });
}

function agentCompletes(sessionId, body = {}, key = idempotencyKey()) {
  return post(`/api/v1/checkout/sessions/${sessionId}/complete`, body,
    agentHeaders({ 'Idempotency-Key': key }));
}

/** Ask the human to sign an approval for exactly this session's current cart. */
async function requestApproval(sessionId, cookie) {
  const res = await get(`/api/v1/checkout/sessions/${sessionId}/approve/challenge`, { Cookie: cookie });
  assert(res.status === 200, 'approval challenge issued to the human', res.body);
  return res.body;
}

async function main() {
  console.log('\n=== Agentic checkout: end-to-end authorization flow ===');

  authenticator = new SoftAuthenticator();
  db.prepare(
    `INSERT INTO users (principal_id, budget_cap_paise, delegation_mode) VALUES (?, ?, 'full')
       ON CONFLICT(principal_id) DO UPDATE SET budget_cap_paise = excluded.budget_cap_paise,
                                              delegation_mode = 'full'`
  ).run(PRINCIPAL, 50000000);
  authenticator.register(db, PRINCIPAL);
  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);

  // ── 1. Discovery: what the merchant advertises is what it serves ─────────
  newScenario('1 - Discovery (GET /.well-known/acp.json)');
  const manifest = await get('/.well-known/acp.json', {});
  assert(manifest.status === 200, 'manifest responds 200', manifest.body);
  assert(manifest.body.supported_protocols.includes('AP2'), 'AP2 is advertised');
  const products = await get(manifest.body.endpoints.products, {});
  assert(products.status === 200, 'every advertised endpoint resolves', products.status);
  const catalogue = products.body.products;
  const item = catalogue.find((p) => p.id === UNDER_CAP_SKU);
  assert(!!item && item.availability === true, `${UNDER_CAP_SKU} is in stock`, item);
  assert(Number.isInteger(item.price) && item.price > 0, 'prices are integer paise', item.price);
  console.log(`    -> ${item.id} @ ${item.price} paise (₹${item.price / 100})`);

  // ── 2. The human creates the agent's authority ───────────────────────────
  newScenario('2 - Human signs a delegation grant (WebAuthn)');
  const cookie = await loginAsHuman();
  const grantId = await issueGrant(cookie);
  console.log(`    -> grant ${grantId}, cap ₹${GRANT_CAP_PAISE / 100}`);
  const grantRow = db
    .prepare('SELECT credential_id FROM delegation_grants WHERE mandate_id = ?')
    .get(grantId);
  assert(
    grantRow.credential_id === authenticator.credentialId,
    "the grant records the human's credential, so its authority is traceable to a device",
    grantRow
  );

  // ── 3. Claim (1): the agent cannot mint its own authority ────────────────
  newScenario('3 - An agent-supplied IntentMandate is refused (claim 1)');
  const selfSigned = await post('/api/v1/checkout/sessions', {
    intent_mandate: {
      mandate_id: 'man_int_self_signed',
      type: 'IntentMandate',
      claims: { constraints: { max_amount: 99999999, currency: 'INR' } },
      proof: { type: 'Ed25519Signature2020', jws: 'stub' },
    },
    requested_items: [{ sku: UNDER_CAP_SKU, quantity: 1 }],
  });
  assert(selfSigned.status === 400, 'a self-made IntentMandate is rejected (400)', selfSigned.body);
  assert(
    selfSigned.body.error.code === 'INTENT_MANDATE_NOT_ACCEPTED',
    'and rejected by name, so a stale caller learns why',
    selfSigned.body.error
  );

  const unknownGrant = await post('/api/v1/checkout/sessions', {
    intent_mandate_id: 'man_int_does_not_exist',
    requested_items: [{ sku: UNDER_CAP_SKU, quantity: 1 }],
  });
  assert(unknownGrant.status === 404, 'a reference to no live grant is a 404', unknownGrant.body);
  assert(unknownGrant.body.error.code === 'GRANT_NOT_FOUND', 'code is GRANT_NOT_FOUND', unknownGrant.body.error);

  // ── 4. Cart lifecycle against the real grant ─────────────────────────────
  newScenario('4 - Cart lifecycle (create, update, read)');
  const created = await agentCreatesCart(grantId, UNDER_CAP_SKU, 1);
  assert(created.status === 201, 'session created (201)', created.body);
  const sessionId = created.body.session_id;
  assert(sessionId.startsWith('acp_sess_'), 'session_id minted', sessionId);
  assert(created.body.state === 'CREATED', 'initial state is CREATED', created.body.state);
  assert(created.body.amount_total === item.price, 'qty 1 total equals unit price', created.body.amount_total);
  assert(created.body.cart_mandate.type === 'CartMandate', 'a CartMandate is issued');
  assert(
    created.body.cart_mandate.prev_mandate_id === grantId,
    "the cart chains to the human's grant",
    created.body.cart_mandate.prev_mandate_id
  );
  assert(
    typeof created.body.expires_at === 'string' && Date.parse(created.body.expires_at) > Date.now(),
    'the quote carries a re-quote deadline',
    created.body.expires_at
  );

  const bumped = await patch(`/api/v1/checkout/sessions/${sessionId}`, {
    requested_items: [{ sku: UNDER_CAP_SKU, quantity: 2 }],
  });
  assert(bumped.status === 200, 'session updated (200)', bumped.body);
  const expectedTotal = item.price * 2;
  assert(bumped.body.amount_total === expectedTotal, 'qty 2 total = unit price x 2', bumped.body.amount_total);
  assert(
    bumped.body.cart_mandate.mandate_id !== created.body.cart_mandate.mandate_id,
    'the replaced cart gets a fresh CartMandate'
  );

  const state = await get(`/api/v1/checkout/sessions/${sessionId}`);
  assert(state.status === 200, 'session fetched (200)', state.body);
  assert(state.body.amount === expectedTotal, 'stored amount matches the patched total', state.body.amount);
  const lineSum = state.body.line_items.reduce((s, x) => s + x.unit_price * x.quantity, 0);
  assert(lineSum === state.body.amount, 'Σ(unit_price x qty) reconciles with amount', { lineSum, amount: state.body.amount });
  assert(state.body.mandate_chain.intent_mandate_id === grantId, 'the chain names the grant', state.body.mandate_chain);
  assert(state.body.mandate_chain.payment_mandate_id === null, 'no PaymentMandate before completion');

  // ── 5. Claim (3): autonomous completion, no cookie anywhere ──────────────
  newScenario('5 - Agent completes autonomously, statelessly (claim 3)');
  const key = idempotencyKey();
  const complete = await agentCompletes(sessionId, {}, key);
  assert(complete.status === 200, 'complete responds 200 on the Order path', complete.body);
  assert(complete.body.state === 'CONFIRMED', 'state -> CONFIRMED', complete.body.state);
  const rzpOrderId = complete.body.order.razorpay_order_id;
  assert(/^order_/.test(rzpOrderId), 'a Razorpay Order id is returned', rzpOrderId);
  assert(
    /^man_pay/.test(complete.body.payment_mandate_id),
    'the merchant minted and signed the PaymentMandate; the caller cannot name one',
    complete.body.payment_mandate_id
  );
  assert(complete.body.next === 'await_webhook', 'next step is await_webhook', complete.body.next);
  console.log(`    -> Razorpay order ${rzpOrderId} for ₹${expectedTotal / 100}, no session cookie involved`);

  // ── 6. Idempotency: a retried key replays, it does not re-charge ─────────
  newScenario('6 - Retry with the same Idempotency-Key');
  const replay = await agentCompletes(sessionId, {}, key);
  assert(replay.status === 200, 'retry replays 200 (not 409)', replay.body);
  assert(
    JSON.stringify(replay.body) === JSON.stringify(complete.body),
    'the replay body is identical to the original completion',
    replay.body
  );
  const differentKey = await agentCompletes(sessionId, {});
  assert(differentKey.status === 409, 'a different key on a settled session is a 409', differentKey.body);

  // ── 7. Claim (2): over the cap, only a human signature moves it ──────────
  newScenario('7 - Over-cap purchase needs a human signature (claim 2)');
  const bigGrant = await issueGrant(cookie);
  const bigCart = await agentCreatesCart(bigGrant, OVER_CAP_SKU, 1);
  assert(bigCart.status === 201, 'the over-cap cart is quotable', bigCart.body);
  const bigSession = bigCart.body.session_id;
  assert(bigCart.body.amount_total > GRANT_CAP_PAISE, 'and it is genuinely over the signed cap', {
    amount: bigCart.body.amount_total,
    cap: GRANT_CAP_PAISE,
  });

  const denied = await agentCompletes(bigSession);
  assert(denied.status === 402, 'the agent alone is refused (402)', denied.body);
  assert(denied.body.error.code === 'APPROVAL_MANDATE_REQUIRED', 'code is APPROVAL_MANDATE_REQUIRED', denied.body.error);

  const request = await requestApproval(bigSession, cookie);
  assert(
    request.approval_mandate.approved_amount === bigCart.body.amount_total,
    'the human is asked for exactly the amount being charged',
    request.approval_mandate
  );
  assert(request.approval_mandate.session_id === bigSession, 'bound to this session', request.approval_mandate.session_id);

  // A forged approval: right shape, wrong device.
  const attacker = new SoftAuthenticator();
  const forged = await agentCompletes(bigSession, {
    approval_mandate: {
      ...request.approval_mandate,
      proof: { type: 'webauthn-assertion', response: attacker.sign(request.webauthn.challenge) },
    },
  });
  assert(forged.status === 402, "another device's signature does not authorize the charge", forged.body);

  // The real one.
  const approved = await agentCompletes(bigSession, {
    approval_mandate: {
      ...request.approval_mandate,
      proof: { type: 'webauthn-assertion', response: authenticator.sign(request.webauthn.challenge) },
    },
  });
  assert(approved.status === 202, 'the human signature escalates it to a payment link (202)', approved.body);
  assert(approved.body.state === 'CONFIRMED', 'state -> CONFIRMED', approved.body.state);
  console.log(`    -> ₹${bigCart.body.amount_total / 100} charged only after a real assertion`);

  // ── 8. Partial delegation: the agent never acts alone ────────────────────
  newScenario('8 - Partial delegation refuses autonomy even far under the cap');
  db.prepare("UPDATE users SET delegation_mode = 'partial' WHERE principal_id = ?").run(PRINCIPAL);
  try {
    const partialGrant = await issueGrant(cookie);
    const smallCart = await agentCreatesCart(partialGrant, UNDER_CAP_SKU, 1);
    assert(smallCart.status === 201, 'a small cart is quotable', smallCart.body);
    const refused = await agentCompletes(smallCart.body.session_id);
    assert(refused.status === 402, 'still refused without an approval (402)', refused.body);
    assert(
      refused.body.error.code === 'APPROVAL_MANDATE_REQUIRED',
      'partial delegation is never autonomous, by design',
      refused.body.error
    );
  } finally {
    db.prepare("UPDATE users SET delegation_mode = 'full' WHERE principal_id = ?").run(PRINCIPAL);
  }

  // ── 9. The audit chain covers all of it ─────────────────────────────────
  newScenario('9 - Audit chain integrity');
  const audit = await get('/audit-log', {});
  assert(audit.status === 200, 'audit log served', audit.status);
  assert(audit.body.integrity.valid === true, 'the hash chain verifies end to end', audit.body.integrity);
  const moneyActions = audit.body.entries.filter((e) => e.event_type === 'MONEY_ACTION');
  assert(moneyActions.length >= 2, 'every charge left a MONEY_ACTION entry', moneyActions.length);
  console.log(`    -> ${audit.body.count} entries, chain valid, ${moneyActions.length} money actions`);

  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(PRINCIPAL);
  console.log(`\n=== PASSED - ${passed} assertions ===`);
  console.log('No buyer key and no human key exist in this process. Every charge above');
  console.log('traces to a WebAuthn assertion produced client-side.\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n=== E2E FLOW FAILED ===');
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
