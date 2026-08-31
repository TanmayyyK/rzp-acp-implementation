'use strict';

/**
 * guardrails.js — the ADR-006 guardrail engine.
 *
 * ADR-006: "Guardrails are pure, server-side functions enforced at every mandate
 * boundary (defense in depth)." This module supplies the guardrails NOT already
 * covered by the mandate-chain validator (schemas/validate.js already enforces
 * the spend cap, expiry, continuity and arithmetic). Here we add:
 *
 *   - category allowlist   (intent → cart boundary)
 *   - quantity limits       (intent → cart boundary)
 *   - single-use replay     (cart → payment boundary)
 *   - velocity              (cart → payment boundary)
 *
 * Design note — why this is a library, not a mounted Express middleware:
 * the boundary guardrails need per-session mandate/cart context that lives in the
 * checkout route's session store, and ADR-006 mandates *pure functions*. So the
 * pure checks below are invoked directly by the route (like validateMandateChain),
 * and the two pieces that inherently need memory across calls — replay and
 * velocity — are isolated in small stateful trackers that delegate to pure logic
 * (the same functional-core / imperative-shell shape as ap2-mandate-validator's
 * createNonceTracker). Every check returns a structured decision the route can
 * hand straight to the audit log and map to an HTTP error code.
 */

/**
 * @typedef {Object} GuardrailDecision
 * @property {string} check                    Machine-readable check id.
 * @property {'PASS'|'FAIL'} outcome
 * @property {Object} detail                    Inputs + reason (audit-logged verbatim).
 */

/** Maps a check id to the documented error code (ARCHITECTURE.md §"Error envelope"). */
const GUARDRAIL_ERROR_CODES = Object.freeze({
  category_allowlist: 'GUARDRAIL_CATEGORY_NOT_ALLOWED', // 403
  quantity: 'GUARDRAIL_QUANTITY_EXCEEDED', // 403
  replay: 'NONCE_REPLAYED', // 409
  velocity: 'GUARDRAIL_VELOCITY_EXCEEDED', // 403
});

/** HTTP status for a failed check. Replay is a conflict; the rest are forbidden. */
function statusFor(decision) {
  return decision.check === 'replay' ? 409 : 403;
}

function errorCodeFor(decision) {
  return GUARDRAIL_ERROR_CODES[decision.check] || 'GUARDRAIL_REJECTED';
}

// Velocity defaults — env-overridable. Velocity is a *rate* guard (the absolute
// spend cap per intent is already enforced by the mandate chain), so these are
// deliberately generous: their job is to catch a runaway agent hammering
// /complete against one intent, not to second-guess the signed budget.
const DEFAULT_VELOCITY = Object.freeze({
  maxCountPerWindow: parseInt(process.env.GUARDRAIL_VELOCITY_MAX_COUNT || '5', 10),
  maxPaisePerWindow: parseInt(process.env.GUARDRAIL_VELOCITY_MAX_PAISE || '50000000', 10),
  windowMs: parseInt(process.env.GUARDRAIL_VELOCITY_WINDOW_MS || '3600000', 10),
});

// ─── Pure checks ──────────────────────────────────────────────────────────

/**
 * Every requested item's product category must be in the intent's allowlist.
 * `resolvedItems` are the server-resolved items { sku, category, quantity, ... };
 * category is read from the product feed (the source of truth), never trusted
 * from the client.
 * @returns {GuardrailDecision}
 */
function checkCategoryAllowlist(resolvedItems, allowedCategories) {
  const allowed = new Set(allowedCategories || []);
  const offending = (resolvedItems || [])
    .filter((it) => !allowed.has(it.category))
    .map((it) => ({ sku: it.sku, category: it.category }));
  return {
    check: 'category_allowlist',
    outcome: offending.length === 0 ? 'PASS' : 'FAIL',
    detail: { allowed_categories: [...allowed], offending_items: offending },
  };
}

/**
 * Every item's requested quantity must be within the product's
 * `max_quantity_per_order` eligibility rule (when the product declares one).
 * @returns {GuardrailDecision}
 */
function checkQuantityLimits(resolvedItems) {
  const offending = (resolvedItems || [])
    .filter(
      (it) =>
        Number.isInteger(it.max_quantity_per_order) &&
        it.quantity > it.max_quantity_per_order
    )
    .map((it) => ({
      sku: it.sku,
      quantity: it.quantity,
      max_quantity_per_order: it.max_quantity_per_order,
    }));
  return {
    check: 'quantity',
    outcome: offending.length === 0 ? 'PASS' : 'FAIL',
    detail: { offending_items: offending },
  };
}

/** Human-readable failure message for an error response. */
function describeFailure(decision) {
  const d = decision.detail || {};
  switch (decision.check) {
    case 'category_allowlist':
      return (
        `line items outside allowed categories [${(d.allowed_categories || []).join(', ')}]: ` +
        (d.offending_items || []).map((o) => `${o.sku} (${o.category})`).join(', ')
      );
    case 'quantity':
      return (
        'requested quantity exceeds per-order limit: ' +
        (d.offending_items || [])
          .map((o) => `${o.sku} (${o.quantity} > ${o.max_quantity_per_order})`)
          .join(', ')
      );
    case 'replay':
      return d.replayed
        ? `payment_id ${d.payment_id} has already been used (replay rejected)`
        : 'payment mandate is missing a valid payment_id';
    case 'velocity': {
      const parts = [];
      if (d.over_count) parts.push(`count ${d.existing_count}+1 > ${d.max_count_per_window}`);
      if (d.over_spend) {
        parts.push(`spend ${d.existing_spend_paise}+${d.amount_paise} > ${d.max_paise_per_window}`);
      }
      return `velocity limit exceeded for intent ${d.intent_id}: ${parts.join('; ')}`;
    }
    default:
      return 'guardrail rejected the request';
  }
}

// ─── Stateful trackers (isolated statefulness) ──────────────────────────────

/**
 * Single-use replay tracker. The PaymentMandate's required, unique `payment_id`
 * (UUID) is treated as its single-use nonce (ADR-006): the exact same payment
 * mandate replayed carries the same payment_id and is rejected. `check` is
 * side-effect free (so the route can audit before committing); `consume` records
 * it — only ever called after the money action succeeds, so a failed attempt
 * doesn't burn the id and a corrected retry can still go through.
 */
function createReplayTracker(initial = []) {
  const seen = new Set(initial);
  return {
    has: (paymentId) => seen.has(paymentId),
    /** @returns {GuardrailDecision} */
    check(paymentId) {
      if (!paymentId || typeof paymentId !== 'string') {
        return { check: 'replay', outcome: 'FAIL', detail: { payment_id: paymentId ?? null, replayed: false } };
      }
      const replayed = seen.has(paymentId);
      return {
        check: 'replay',
        outcome: replayed ? 'FAIL' : 'PASS',
        detail: { payment_id: paymentId, replayed },
      };
    },
    consume(paymentId) {
      seen.add(paymentId);
    },
    size: () => seen.size,
    reset: () => seen.clear(),
  };
}

/**
 * Velocity is deliberately NOT a tracker object here.
 *
 * The money boundary needs an atomic check-and-reserve (the TOCTOU fix): a pure
 * `check` that returns a decision, followed later by a `record`, is precisely the
 * race that let M concurrent /complete calls each read spend=0 and all charge. So
 * velocity is owned end-to-end by src/lib/velocityTracker.js
 * (reserveSpend/commitSpend/releaseSpend under a per-principal mutex) and invoked
 * directly by the route, which is the only layer that knows whether the downstream
 * charge succeeded. It is also keyed strictly by principal_id: keying by intent_id
 * would let an agent clear any cap by opening many small intents.
 *
 * A `createVelocityTracker(...)` shim used to be exported here for the old
 * check-then-record shape. Nothing in src/ called it, its `reset` could not clear
 * the shared ledger, and its `check` re-introduced the non-atomic read — so it is
 * gone rather than kept working-ish. Likewise `evaluatePaymentGuardrails`, whose
 * only purpose was to compose that check with the replay check; the route now
 * composes replayTracker.check + reserveSpend, which is the only ordering that can
 * be both audited and atomic.
 */

// ─── Composite evaluators (one per mandate boundary) ─────────────────────────

/**
 * Intent → cart boundary. Runs the checks a merchant must satisfy before it
 * mints a cart under the buyer's intent.
 * @returns {{ decisions: GuardrailDecision[], ok: boolean }}
 */
function evaluateCartGuardrails({ allowedCategories, resolvedItems }) {
  const decisions = [
    checkCategoryAllowlist(resolvedItems, allowedCategories),
    checkQuantityLimits(resolvedItems),
  ];
  return { decisions, ok: decisions.every((d) => d.outcome === 'PASS') };
}

module.exports = {
  GUARDRAIL_ERROR_CODES,
  DEFAULT_VELOCITY,
  statusFor,
  errorCodeFor,
  describeFailure,
  checkCategoryAllowlist,
  checkQuantityLimits,
  createReplayTracker,
  evaluateCartGuardrails,
};
