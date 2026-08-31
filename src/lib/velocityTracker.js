'use strict';

/**
 * In-memory sliding-window velocity tracker for the Agentic Commerce
 * Protocol — HARDENED with per-principal async mutex.
 *
 * Spend is tracked strictly by `principal_id` — the human/account
 * ultimately liable for the funds — and deliberately NEVER by
 * `intent_id` or `session_id`. Keying by intent would let an agent (or
 * a bug) bypass a spending cap simply by opening many small intents
 * against the same principal; keying by principal_id is what makes the
 * cap actually mean something.
 *
 * TOCTOU FIX (Critical 4 from adversarial audit):
 * The old check-then-record pattern yielded the event loop between
 * checkVelocity (read-only) and recordSpend (mutating), so M concurrent
 * requests could all read currentSpend=0, all pass, and all charge.
 *
 * The new pattern is: reserveSpend() acquires a per-principal async
 * mutex, checks limits (both spend AND count), and if allowed, appends
 * a provisional ledger entry *inside* the critical section so concurrent
 * callers see the reserved amount. After the downstream operation
 * (e.g. Razorpay call): commitSpend(reservation) finalizes it, or
 * releaseSpend(reservation) rolls it back on failure.
 *
 * Dependency-free. No I/O beyond Date.now().
 */

const crypto = require('crypto');

/** @type {Map<string, Array<{ id?: string, amountPaise: number, timestamp: number, provisional: boolean }>>} */
const ledger = new Map();

/** @type {Map<string, Promise<void>>} */
const mutexes = new Map();

/** @type {Map<string, () => void>} */
const mutexReleases = new Map();

// Default count cap: 5 transactions per window (was documented but never enforced)
const DEFAULT_MAX_COUNT_PER_WINDOW = parseInt(process.env.GUARDRAIL_VELOCITY_MAX_COUNT || '5', 10);

function assertPrincipalId(principalId) {
  if (typeof principalId !== 'string' || principalId.trim().length === 0) {
    throw new TypeError('principalId must be a non-empty string');
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer (paise)`);
  }
}

/**
 * Acquire a per-principal async mutex. Returns a release function.
 * Uses a promise-chain pattern: each caller chains onto the previous
 * caller's promise, so only one runs at a time per principal.
 *
 * @param {string} principalId
 * @returns {Promise<() => void>} release function
 */
function acquireMutex(principalId) {
  let release;
  const newMutex = new Promise((resolve) => {
    release = resolve;
  });

  const prevMutex = mutexes.get(principalId) || Promise.resolve();
  mutexes.set(principalId, newMutex);

  return prevMutex.then(() => release);
}

/**
 * Drops ledger entries for a principal that have aged out of the given
 * window (garbage-collecting the ledger as a side effect), and returns
 * the surviving in-window entries.
 *
 * @param {string} principalId
 * @param {number} windowMs
 * @param {number} now
 * @returns {Array<{ amountPaise: number, timestamp: number, provisional: boolean }>}
 */
function pruneAndGetEntries(principalId, windowMs, now) {
  const entries = ledger.get(principalId) || [];
  const windowStart = now - windowMs;
  const inWindow = entries.filter((entry) => entry.timestamp > windowStart);

  if (inWindow.length !== entries.length) {
    ledger.set(principalId, inWindow);
  }

  return inWindow;
}

/**
 * NON-ATOMIC read-only velocity check. Retained for backwards compatibility
 * with guardrails.js pure-check pattern, but callers requiring atomicity
 * MUST use reserveSpend() instead.
 *
 * @param {string} principalId
 * @param {number} amountPaise - Proposed additional spend, in paise.
 * @param {number} capPaise - Velocity cap for this principal, in paise.
 * @param {number} windowMs - Sliding window length, in milliseconds.
 * @returns {{
 *   allowed: boolean,
 *   currentSpendPaise: number,
 *   projectedSpendPaise: number,
 *   capPaise: number,
 *   remainingPaise: number,
 * }}
 */
function checkVelocity(principalId, amountPaise, capPaise, windowMs) {
  assertPrincipalId(principalId);
  assertPositiveInteger(amountPaise, 'amountPaise');
  assertPositiveInteger(capPaise, 'capPaise');
  assertPositiveInteger(windowMs, 'windowMs');

  const now = Date.now();
  const entries = pruneAndGetEntries(principalId, windowMs, now);
  const currentSpendPaise = entries.reduce((sum, entry) => sum + entry.amountPaise, 0);
  const projectedSpendPaise = currentSpendPaise + amountPaise;
  const allowed = projectedSpendPaise <= capPaise;

  return {
    allowed,
    currentSpendPaise,
    projectedSpendPaise,
    capPaise,
    remainingPaise: Math.max(capPaise - currentSpendPaise, 0),
  };
}

/**
 * NON-ATOMIC spend recorder. Retained for backwards compatibility.
 * In new code, use reserveSpend() + commitSpend().
 *
 * @param {string} principalId
 * @param {number} amountPaise - Committed spend amount, in paise.
 * @returns {{ principalId: string, amountPaise: number, timestamp: number }}
 */
function recordSpend(principalId, amountPaise) {
  assertPrincipalId(principalId);
  assertPositiveInteger(amountPaise, 'amountPaise');

  const timestamp = Date.now();
  const entries = ledger.get(principalId) || [];
  entries.push({ amountPaise, timestamp, provisional: false });
  ledger.set(principalId, entries);

  return { principalId, amountPaise, timestamp };
}

/**
 * ATOMIC reserve: acquires per-principal mutex, checks spend+count caps,
 * and if allowed, writes a provisional entry so concurrent callers see
 * the reserved amount. Returns a reservation UUID.
 *
 * Throws VelocityExceededError if the cap would be breached.
 *
 * The caller MUST call commitSpend(principalId, reservationId) or 
 * releaseSpend(principalId, reservationId) after the downstream operation 
 * completes — never leave a reservation dangling.
 *
 * @param {string} principalId
 * @param {number} amountPaise
 * @param {number} capPaise
 * @param {number} windowMs
 * @param {number} [maxCount] - max transaction count per window (default 5)
 * @returns {Promise<string>} reservationId
 * @throws {VelocityExceededError}
 */
async function reserveSpend(principalId, amountPaise, capPaise, windowMs, maxCount) {
  assertPrincipalId(principalId);
  assertPositiveInteger(amountPaise, 'amountPaise');
  assertPositiveInteger(capPaise, 'capPaise');
  assertPositiveInteger(windowMs, 'windowMs');

  const effectiveMaxCount = maxCount || DEFAULT_MAX_COUNT_PER_WINDOW;
  const release = await acquireMutex(principalId);

  try {
    const now = Date.now();
    const entries = pruneAndGetEntries(principalId, windowMs, now);
    const currentSpendPaise = entries.reduce((sum, e) => sum + e.amountPaise, 0);
    const currentCount = entries.length;
    const projectedSpend = currentSpendPaise + amountPaise;
    const projectedCount = currentCount + 1;

    // Check spend cap
    if (projectedSpend > capPaise) {
      throw new VelocityExceededError(
        `Velocity spend cap breached: ${currentSpendPaise}+${amountPaise} = ${projectedSpend} > ${capPaise}`,
        { currentSpendPaise, amountPaise, projectedSpend, capPaise, reason: 'spend' }
      );
    }

    // Check count cap (was documented as "5 per window" but never enforced)
    if (projectedCount > effectiveMaxCount) {
      throw new VelocityExceededError(
        `Velocity count cap breached: ${currentCount}+1 = ${projectedCount} > ${effectiveMaxCount}`,
        { currentCount, projectedCount, maxCount: effectiveMaxCount, reason: 'count' }
      );
    }

    const reservationId = crypto.randomUUID();

    // Write provisional entry so concurrent callers see this reservation
    const provisionalEntry = { id: reservationId, amountPaise, timestamp: now, provisional: true };
    entries.push(provisionalEntry);
    ledger.set(principalId, entries);

    mutexReleases.set(reservationId, release);

    return reservationId;
  } catch (err) {
    // Release mutex on check failure
    release();
    throw err;
  }
}

/**
 * Finalize a reservation: mark the provisional entry as committed and
 * release the per-principal mutex.
 *
 * @param {string} principalId
 * @param {string} reservationId
 */
function commitSpend(principalId, reservationId) {
  if (!reservationId) return;

  const entries = ledger.get(principalId);
  if (entries) {
    const entry = entries.find(e => e.id === reservationId);
    if (entry) {
      entry.provisional = false;
    }
  }

  const release = mutexReleases.get(reservationId);
  if (release) {
    release();
    mutexReleases.delete(reservationId);
  }
}

/**
 * Roll back a reservation: remove the provisional entry from the ledger
 * (payment failed, declined, etc.) and release the mutex.
 *
 * @param {string} principalId
 * @param {string} reservationId
 */
function releaseSpend(principalId, reservationId) {
  if (!reservationId) return;

  const entries = ledger.get(principalId);
  if (entries) {
    // Remove the provisional entry by UUID
    const newEntries = entries.filter(e => e.id !== reservationId);
    ledger.set(principalId, newEntries);
  }

  const release = mutexReleases.get(reservationId);
  if (release) {
    release();
    mutexReleases.delete(reservationId);
  }
}

/**
 * Error thrown when a velocity cap (spend or count) would be breached.
 */
class VelocityExceededError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'VelocityExceededError';
    this.code = 'VELOCITY_EXCEEDED';
    this.detail = detail;
  }
}

/**
 * Reset all ledger state. Used by tests.
 */
function resetLedger() {
  ledger.clear();
  mutexes.clear();
  mutexReleases.clear();
}

module.exports = {
  checkVelocity,
  recordSpend,
  reserveSpend,
  commitSpend,
  releaseSpend,
  resetLedger,
  VelocityExceededError,
};
