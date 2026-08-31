const fs = require('fs');
const file = 'src/lib/velocityTracker.js';
let content = fs.readFileSync(file, 'utf8');

const cryptoRequire = `const crypto = require('crypto');\n\n/** @type {Map<string, Array<{ id?: string, amountPaise: number, timestamp: number, provisional: boolean }>>} */`;

content = content.replace(`/** @type {Map<string, Array<{ amountPaise: number, timestamp: number, provisional: boolean }>>} */`, cryptoRequire);

const mutexReleases = `/** @type {Map<string, () => void>} */\nconst mutexReleases = new Map();`;
content = content.replace(`/** @type {Map<string, Promise<void>>} */\nconst mutexes = new Map();`, `/** @type {Map<string, Promise<void>>} */\nconst mutexes = new Map();\n\n${mutexReleases}`);

const oldReserveSpend = `/**
 * @typedef {Object} Reservation
 * @property {string} principalId
 * @property {number} amountPaise
 * @property {number} timestamp
 * @property {number} entryIndex - index of the provisional entry in the ledger
 * @property {() => void} _release - mutex release function (internal)
 * @property {boolean} settled - whether commit or release has been called
 */

/**
 * ATOMIC reserve: acquires per-principal mutex, checks spend+count caps,
 * and if allowed, writes a provisional entry so concurrent callers see
 * the reserved amount. Returns a reservation handle.
 *
 * Throws VelocityExceededError if the cap would be breached.
 *
 * The caller MUST call commitSpend(reservation) or releaseSpend(reservation)
 * after the downstream operation completes — never leave a reservation dangling.
 *
 * @param {string} principalId
 * @param {number} amountPaise
 * @param {number} capPaise
 * @param {number} windowMs
 * @param {number} [maxCount] - max transaction count per window (default 5)
 * @returns {Promise<Reservation>}
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
        \`Velocity spend cap breached: \${currentSpendPaise}+\${amountPaise} = \${projectedSpend} > \${capPaise}\`,
        { currentSpendPaise, amountPaise, projectedSpend, capPaise, reason: 'spend' }
      );
    }

    // Check count cap (was documented as "5 per window" but never enforced)
    if (projectedCount > effectiveMaxCount) {
      throw new VelocityExceededError(
        \`Velocity count cap breached: \${currentCount}+1 = \${projectedCount} > \${effectiveMaxCount}\`,
        { currentCount, projectedCount, maxCount: effectiveMaxCount, reason: 'count' }
      );
    }

    // Write provisional entry so concurrent callers see this reservation
    const provisionalEntry = { amountPaise, timestamp: now, provisional: true };
    entries.push(provisionalEntry);
    ledger.set(principalId, entries);

    return {
      principalId,
      amountPaise,
      timestamp: now,
      entryIndex: entries.length - 1,
      _release: release,
      settled: false,
    };
  } catch (err) {
    // Release mutex on check failure
    release();
    throw err;
  }
}`;

const newReserveSpend = `/**
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
        \`Velocity spend cap breached: \${currentSpendPaise}+\${amountPaise} = \${projectedSpend} > \${capPaise}\`,
        { currentSpendPaise, amountPaise, projectedSpend, capPaise, reason: 'spend' }
      );
    }

    // Check count cap (was documented as "5 per window" but never enforced)
    if (projectedCount > effectiveMaxCount) {
      throw new VelocityExceededError(
        \`Velocity count cap breached: \${currentCount}+1 = \${projectedCount} > \${effectiveMaxCount}\`,
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
}`;

content = content.replace(oldReserveSpend, newReserveSpend);

const oldCommit = `/**
 * Finalize a reservation: mark the provisional entry as committed and
 * release the per-principal mutex.
 *
 * @param {Reservation} reservation
 */
function commitSpend(reservation) {
  if (!reservation || reservation.settled) return;
  reservation.settled = true;

  const entries = ledger.get(reservation.principalId);
  if (entries && entries[reservation.entryIndex]) {
    entries[reservation.entryIndex].provisional = false;
  }

  reservation._release();
}`;

const newCommit = `/**
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
}`;

content = content.replace(oldCommit, newCommit);

const oldRelease = `/**
 * Roll back a reservation: remove the provisional entry from the ledger
 * (payment failed, declined, etc.) and release the mutex.
 *
 * @param {Reservation} reservation
 */
function releaseSpend(reservation) {
  if (!reservation || reservation.settled) return;
  reservation.settled = true;

  const entries = ledger.get(reservation.principalId);
  if (entries) {
    // Remove the provisional entry by index
    entries.splice(reservation.entryIndex, 1);
    ledger.set(reservation.principalId, entries);
  }

  reservation._release();
}`;

const newRelease = `/**
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
}`;

content = content.replace(oldRelease, newRelease);

content = content.replace(`function resetLedger() {
  ledger.clear();
  mutexes.clear();
}`, `function resetLedger() {
  ledger.clear();
  mutexes.clear();
  mutexReleases.clear();
}`);

fs.writeFileSync(file, content);
console.log('velocityTracker.js updated.');
