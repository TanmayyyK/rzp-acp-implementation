'use strict';

/**
 * Unit tests for the ADR-006 guardrail engine (src/middleware/guardrails.js).
 *
 * These are pure — no Express, no sockets, no Razorpay — so they run in this
 * sandbox (which blocks port binding). Time-dependent velocity tests pass an
 * explicit `now` rather than mocking Date, keeping them deterministic.
 */

const {
  GUARDRAIL_ERROR_CODES,
  statusFor,
  errorCodeFor,
  describeFailure,
  checkCategoryAllowlist,
  checkQuantityLimits,
  createReplayTracker,
  evaluateCartGuardrails,
} = require('../src/middleware/guardrails');
const {
  reserveSpend,
  commitSpend,
  releaseSpend,
  resetLedger,
  VelocityExceededError,
} = require('../src/lib/velocityTracker');

// A representative resolved-items view (the shape resolveLineItems emits).
const AUDIO_ITEM = { sku: 'prod_electronics_001', category: 'audio', quantity: 2, max_quantity_per_order: 5 };
const WEARABLE_ITEM = { sku: 'prod_electronics_003', category: 'wearables', quantity: 1, max_quantity_per_order: 3 };

describe('checkCategoryAllowlist', () => {
  test('PASS when every item category is in the allowlist', () => {
    const d = checkCategoryAllowlist([AUDIO_ITEM], ['audio', 'wearables']);
    expect(d.check).toBe('category_allowlist');
    expect(d.outcome).toBe('PASS');
    expect(d.detail.offending_items).toEqual([]);
  });

  test('FAIL when any item category is outside the allowlist, listing the offender', () => {
    const d = checkCategoryAllowlist([AUDIO_ITEM, WEARABLE_ITEM], ['audio']);
    expect(d.outcome).toBe('FAIL');
    expect(d.detail.offending_items).toEqual([
      { sku: 'prod_electronics_003', category: 'wearables' },
    ]);
    expect(d.detail.allowed_categories).toEqual(['audio']);
  });

  test('FAIL when the allowlist is empty/missing', () => {
    expect(checkCategoryAllowlist([AUDIO_ITEM], []).outcome).toBe('FAIL');
    expect(checkCategoryAllowlist([AUDIO_ITEM], undefined).outcome).toBe('FAIL');
  });

  test('PASS vacuously on no items', () => {
    expect(checkCategoryAllowlist([], ['audio']).outcome).toBe('PASS');
  });
});

describe('checkQuantityLimits', () => {
  test('PASS when every quantity is within its per-order limit', () => {
    const d = checkQuantityLimits([AUDIO_ITEM, WEARABLE_ITEM]);
    expect(d.check).toBe('quantity');
    expect(d.outcome).toBe('PASS');
  });

  test('PASS at exactly the limit (boundary)', () => {
    const d = checkQuantityLimits([{ ...AUDIO_ITEM, quantity: 5, max_quantity_per_order: 5 }]);
    expect(d.outcome).toBe('PASS');
  });

  test('FAIL when a quantity exceeds its per-order limit', () => {
    const d = checkQuantityLimits([{ ...AUDIO_ITEM, quantity: 6, max_quantity_per_order: 5 }]);
    expect(d.outcome).toBe('FAIL');
    expect(d.detail.offending_items).toEqual([
      { sku: 'prod_electronics_001', quantity: 6, max_quantity_per_order: 5 },
    ]);
  });

  test('ignores items without a declared max_quantity_per_order', () => {
    const d = checkQuantityLimits([{ sku: 'x', category: 'audio', quantity: 9999 }]);
    expect(d.outcome).toBe('PASS');
  });
});

describe('createReplayTracker', () => {
  test('first use PASSes, and check is non-mutating (repeatable)', () => {
    const t = createReplayTracker();
    expect(t.check('pay-1').outcome).toBe('PASS');
    expect(t.check('pay-1').outcome).toBe('PASS'); // still PASS — check didn't consume
    expect(t.has('pay-1')).toBe(false);
    expect(t.size()).toBe(0);
  });

  test('consume burns the id; a replay of the same id then FAILs', () => {
    const t = createReplayTracker();
    t.consume('pay-1');
    expect(t.has('pay-1')).toBe(true);
    const d = t.check('pay-1');
    expect(d.outcome).toBe('FAIL');
    expect(d.detail).toEqual({ payment_id: 'pay-1', replayed: true });
    expect(errorCodeFor(d)).toBe('NONCE_REPLAYED');
    expect(statusFor(d)).toBe(409);
  });

  test('a different id is unaffected by a prior consume', () => {
    const t = createReplayTracker(['pay-1']);
    expect(t.check('pay-2').outcome).toBe('PASS');
  });

  test('FAIL (not throw) on a missing/invalid payment id', () => {
    const t = createReplayTracker();
    const d = t.check(undefined);
    expect(d.outcome).toBe('FAIL');
    expect(d.detail.replayed).toBe(false);
  });
});

// Velocity is NOT a guardrails.js tracker — it is owned by
// src/lib/velocityTracker.js, because the money boundary needs an atomic
// check-and-reserve rather than a pure check followed by a later record. These
// tests pin that contract, including the two invariants the old per-intent
// check-then-record shim got wrong: spend is keyed by principal (never by
// intent), and a reservation is only visible-and-final once committed.
describe('velocity (atomic reserve/commit at the money boundary)', () => {
  const CAP = 1000;
  const WINDOW_MS = 60_000;

  beforeEach(() => resetLedger());
  afterAll(() => resetLedger());

  test('reserve under the cap succeeds and commit keeps the spend in the window', async () => {
    const r1 = await reserveSpend('usr_v1', 500, CAP, WINDOW_MS);
    commitSpend('usr_v1', r1);
    // 500 committed + 600 would breach 1000.
    await expect(reserveSpend('usr_v1', 600, CAP, WINDOW_MS)).rejects.toThrow(VelocityExceededError);
  });

  test('release rolls the reservation back, so the cap is free again', async () => {
    const r1 = await reserveSpend('usr_v2', 900, CAP, WINDOW_MS);
    releaseSpend('usr_v2', r1); // e.g. Razorpay declined
    const r2 = await reserveSpend('usr_v2', 900, CAP, WINDOW_MS);
    expect(r2).toEqual(expect.any(String));
    commitSpend('usr_v2', r2);
  });

  test('the count ceiling is enforced, not just the spend ceiling', async () => {
    for (let i = 0; i < 2; i++) commitSpend('usr_v3', await reserveSpend('usr_v3', 1, CAP, WINDOW_MS, 2));
    await expect(reserveSpend('usr_v3', 1, CAP, WINDOW_MS, 2)).rejects.toMatchObject({
      code: 'VELOCITY_EXCEEDED',
      detail: expect.objectContaining({ reason: 'count' }),
    });
  });

  test('spend is keyed by principal — a second principal has its own window', async () => {
    commitSpend('usr_v4', await reserveSpend('usr_v4', 1000, CAP, WINDOW_MS));
    await expect(reserveSpend('usr_v4', 1, CAP, WINDOW_MS)).rejects.toThrow(VelocityExceededError);
    const other = await reserveSpend('usr_v5', 1000, CAP, WINDOW_MS);
    expect(other).toEqual(expect.any(String));
    commitSpend('usr_v5', other);
  });

  test('concurrent reservations cannot both pass the cap (TOCTOU)', async () => {
    const first = await reserveSpend('usr_v6', 600, CAP, WINDOW_MS);

    // A second caller arriving while the first is still in flight must NOT be
    // able to read the pre-reservation ledger: reserveSpend holds a per-principal
    // mutex from reserve until commit/release, so this stays queued.
    let outcome = 'pending';
    const second = reserveSpend('usr_v6', 600, CAP, WINDOW_MS).then(
      (id) => { outcome = 'granted'; return id; },
      (err) => { outcome = 'rejected'; throw err; }
    );
    await new Promise((resolve) => setImmediate(resolve)); // flush microtasks
    expect(outcome).toBe('pending');

    // Once the first charge lands, the second sees it — 600+600 > 1000.
    commitSpend('usr_v6', first);
    await expect(second).rejects.toThrow(VelocityExceededError);
  });

  test('a failed check maps to the documented 403 error code', () => {
    expect(errorCodeFor({ check: 'velocity' })).toBe('GUARDRAIL_VELOCITY_EXCEEDED');
    expect(statusFor({ check: 'velocity' })).toBe(403);
  });
});

describe('evaluateCartGuardrails (intent -> cart composite)', () => {
  test('ok=true and two PASS decisions when category + quantity both hold', () => {
    const r = evaluateCartGuardrails({
      allowedCategories: ['audio', 'wearables'],
      resolvedItems: [AUDIO_ITEM, WEARABLE_ITEM],
    });
    expect(r.ok).toBe(true);
    expect(r.decisions.map((d) => d.check)).toEqual(['category_allowlist', 'quantity']);
    expect(r.decisions.every((d) => d.outcome === 'PASS')).toBe(true);
  });

  test('ok=false when a category is disallowed', () => {
    const r = evaluateCartGuardrails({
      allowedCategories: ['audio'],
      resolvedItems: [WEARABLE_ITEM],
    });
    expect(r.ok).toBe(false);
    const failed = r.decisions.find((d) => d.outcome === 'FAIL');
    expect(failed.check).toBe('category_allowlist');
  });

  test('ok=false when a quantity is over its limit', () => {
    const r = evaluateCartGuardrails({
      allowedCategories: ['audio'],
      resolvedItems: [{ ...AUDIO_ITEM, quantity: 99 }],
    });
    expect(r.ok).toBe(false);
    expect(r.decisions.find((d) => d.outcome === 'FAIL').check).toBe('quantity');
  });
});

describe('error-code mapping + descriptions', () => {
  test('each check id maps to its documented error code', () => {
    expect(GUARDRAIL_ERROR_CODES).toEqual({
      category_allowlist: 'GUARDRAIL_CATEGORY_NOT_ALLOWED',
      quantity: 'GUARDRAIL_QUANTITY_EXCEEDED',
      replay: 'NONCE_REPLAYED',
      velocity: 'GUARDRAIL_VELOCITY_EXCEEDED',
    });
  });

  test('replay is a 409 conflict; other checks are 403 forbidden', () => {
    expect(statusFor({ check: 'replay' })).toBe(409);
    expect(statusFor({ check: 'category_allowlist' })).toBe(403);
    expect(statusFor({ check: 'quantity' })).toBe(403);
    expect(statusFor({ check: 'velocity' })).toBe(403);
  });

  test('describeFailure produces a human-readable message per check', () => {
    const cat = checkCategoryAllowlist([WEARABLE_ITEM], ['audio']);
    expect(describeFailure(cat)).toMatch(/prod_electronics_003 \(wearables\)/);

    const qty = checkQuantityLimits([{ ...AUDIO_ITEM, quantity: 6, max_quantity_per_order: 5 }]);
    expect(describeFailure(qty)).toMatch(/6 > 5/);
  });
});
