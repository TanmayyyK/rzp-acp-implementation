'use strict';

/**
 * /chat wiring — socket-free integration tests for the dashboard's left panel.
 *
 * Drives the REAL composition-root app (src/server.js) via app.handle() with a
 * mock request/response (tests/helpers/mockHttp.js) — no port is bound, matching
 * the sandbox constraint and auditWiring.test.js.
 *
 * It pins the two things the split-screen integration depends on:
 *   1. the exact view-model shape public/js/chat.js renders (agent bubbles read
 *      `content`; receipts read NUMERIC `data.*` and format client-side), and
 *   2. the audit wiring that links the left panel to the HashChain panel — every
 *      turn appends AGENT_REASONING, a purchase adds MONEY_ACTION (confirmed) or
 *      GUARDRAIL_DECISION (escalated), and the receipt's `refId` is that block's
 *      real hash.
 *
 * Each case loads the app in its own module registry (jest.isolateModules) so the
 * process-wide audit chain starts fresh at [GENESIS] and the auto-approve
 * threshold can be pinned per case — making the confirmed/escalated branch
 * deterministic despite the stub's random cart amount.
 */

const { handle } = require('./helpers/mockHttp');

const ORIGINAL_THRESHOLD = process.env.AUTO_APPROVE_THRESHOLD_PAISE;

/** Load a fresh app + its shared chain with a pinned auto-approve threshold. */
function loadApp(thresholdPaise) {
  let app;
  let sharedAuditLog;
  jest.isolateModules(() => {
    process.env.AUTO_APPROVE_THRESHOLD_PAISE = String(thresholdPaise);
    app = require('../src/server');
    ({ sharedAuditLog } = require('../src/lib/auditLog'));
  });
  return { app, sharedAuditLog };
}

async function postChat(app, body) {
  const res = await handle(app, {
    method: 'POST',
    url: '/chat',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, messages: JSON.parse(res.captured) };
}

afterAll(() => {
  if (ORIGINAL_THRESHOLD === undefined) delete process.env.AUTO_APPROVE_THRESHOLD_PAISE;
  else process.env.AUTO_APPROVE_THRESHOLD_PAISE = ORIGINAL_THRESHOLD;
});

describe('POST /chat — non-purchase message', () => {
  test('returns a single agent bubble using `content`, and records one AGENT_REASONING block', async () => {
    const { app, sharedAuditLog } = loadApp(1000000);
    const before = sharedAuditLog.entries().length;

    const { statusCode, messages } = await postChat(app, { message: 'what can you do?', provider: 'stub' });

    expect(statusCode).toBe(200);
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('agent');
    // chat.js renders `content` (falls back to `message`), never `text`.
    expect(typeof messages[0].content).toBe('string');
    expect(messages[0].content.length).toBeGreaterThan(0);

    const added = sharedAuditLog.entries().slice(before);
    expect(added.map((e) => e.event_type)).toEqual(['AGENT_REASONING']);
    expect(added[0].actor).toBe('buyer_agent');
    expect(sharedAuditLog.verifyChain()).toEqual({ valid: true, brokenAt: null });
  });
});

describe('POST /chat — purchase below the auto-approve threshold (confirmed)', () => {
  test('returns a numeric receipt whose refId is a real MONEY_ACTION block hash', async () => {
    // Threshold ₹1,000,000 — the stub cart (≤ ~₹16.5k) is always auto-approved.
    const { app, sharedAuditLog } = loadApp(100000000);
    const before = sharedAuditLog.entries().length;

    const { messages } = await postChat(app, { message: 'buy me a mechanical keyboard', provider: 'stub' });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('agent');
    expect(typeof messages[0].content).toBe('string');

    const receipt = messages[1];
    expect(receipt.role).toBe('receipt');
    const d = receipt.data; // chat.js reads `data` (or `receipt`); we send `data`.
    expect(d.status).toBe('confirmed');
    expect(d.merchantName).toBe('Marketplace via AP2');
    // Amounts are NUMBERS (rupees) — the client formats them, the server never
    // sends label strings.
    expect(typeof d.subtotal).toBe('number');
    expect(typeof d.tax).toBe('number');
    expect(typeof d.total).toBe('number');
    expect(d.tax).toBe(Math.round(d.subtotal * 0.18));
    expect(d.total).toBe(d.subtotal + d.tax);
    expect(d.items[0].price).toBe(d.subtotal);

    const added = sharedAuditLog.entries().slice(before);
    // A purchase now narrates a visible cycle: the opening reasoning, a
    // search_catalog step, the IntentMandate, a create_cart step, then the money move.
    expect(added.map((e) => e.event_type)).toEqual([
      'AGENT_REASONING', 'AGENT_REASONING', 'MANDATE_ISSUED', 'AGENT_REASONING', 'MONEY_ACTION',
    ]);
    // The purchase issues the buyer's IntentMandate on the shared chain (default
    // Stub demo), so the Inspector's mandate card + budget cap have a real source.
    const mandate = added[2];
    expect(mandate.event_type).toBe('MANDATE_ISSUED');
    expect(typeof mandate.payload.mandate.max_paise).toBe('number');
    const money = added[4];
    expect(money.actor).toBe('merchant_server');
    expect(money.payload.order_id).toBe(d.orderId);
    expect(money.payload.amount_rupees).toBe(d.total);
    // The receipt's chain reference IS the money block's hash (cross-panel link).
    expect(d.refId).toBe(money.hash);
    expect(sharedAuditLog.verifyChain().valid).toBe(true);
  });
});

describe('POST /chat — purchase above the auto-approve threshold (escalated)', () => {
  test('holds for approval and records a GUARDRAIL_DECISION instead of a MONEY_ACTION', async () => {
    // Threshold ₹0 — every purchase escalates to human approval.
    const { app, sharedAuditLog } = loadApp(0);
    const before = sharedAuditLog.entries().length;

    const { messages } = await postChat(app, { message: 'order the flagship phone', provider: 'stub' });

    const receipt = messages[1];
    expect(receipt.data.status).toBe('pending_approval');

    const added = sharedAuditLog.entries().slice(before);
    expect(added.map((e) => e.event_type)).toEqual([
      'AGENT_REASONING', 'AGENT_REASONING', 'MANDATE_ISSUED', 'AGENT_REASONING', 'GUARDRAIL_DECISION',
    ]);
    // Mandate is issued before the guardrail rules on it — even an escalated
    // purchase has a real IntentMandate + cap behind the Inspector.
    const mandate = added[2];
    expect(mandate.event_type).toBe('MANDATE_ISSUED');
    expect(typeof mandate.payload.mandate.max_paise).toBe('number');
    const decision = added[4];
    expect(decision.actor).toBe('guardrail');
    expect(decision.payload.decision).toBe('ESCALATE_TO_HUMAN');
    expect(decision.payload.amount_rupees).toBe(receipt.data.total);
    expect(receipt.data.refId).toBe(decision.hash);
    // No money moved on an escalation.
    expect(added.some((e) => e.event_type === 'MONEY_ACTION')).toBe(false);
    expect(sharedAuditLog.verifyChain().valid).toBe(true);
  });
});

describe('POST /chat — budget from the composer sets the mandate cap', () => {
  test('a purchase mints the IntentMandate at the budget the user allocated', async () => {
    // The composer sends a ₹5,000 budget; it becomes the IntentMandate ceiling,
    // independent of the system auto-approve threshold (here ₹10,000).
    const { app, sharedAuditLog } = loadApp(1000000);
    const before = sharedAuditLog.entries().length;

    await postChat(app, { message: 'buy a watch', provider: 'stub', budget: 5000 });

    const added = sharedAuditLog.entries().slice(before);
    const mandate = added.find((e) => e.event_type === 'MANDATE_ISSUED');
    expect(mandate).toBeDefined();
    expect(mandate.payload.mandate.max_paise).toBe(500000);
    expect(sharedAuditLog.verifyChain().valid).toBe(true);
  });
});
