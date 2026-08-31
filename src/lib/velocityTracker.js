'use strict';

/** Durable, transactionally reserved velocity budget. */

const crypto = require('crypto');
const db = require('../db');

const DEFAULT_MAX_COUNT_PER_WINDOW = parseInt(process.env.GUARDRAIL_VELOCITY_MAX_COUNT || '5', 10);

class VelocityExceededError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'VelocityExceededError';
    this.code = 'VELOCITY_EXCEEDED';
    this.detail = detail;
  }
}

function assertPrincipalId(principalId) {
  if (typeof principalId !== 'string' || principalId.trim() === '') throw new TypeError('principalId must be a non-empty string');
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer (paise)`);
}

function inWindow(principalId, windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  db.prepare('DELETE FROM velocity_ledger WHERE principal_id = ? AND timestamp_ms <= ?').run(principalId, cutoff);
  return db.prepare(
    'SELECT reservation_id, amount_paise, timestamp_ms, provisional FROM velocity_ledger WHERE principal_id = ? AND timestamp_ms > ?'
  ).all(principalId, cutoff);
}

function checkVelocity(principalId, amountPaise, capPaise, windowMs) {
  assertPrincipalId(principalId);
  assertPositiveInteger(amountPaise, 'amountPaise');
  assertPositiveInteger(capPaise, 'capPaise');
  assertPositiveInteger(windowMs, 'windowMs');
  const entries = inWindow(principalId, windowMs);
  const currentSpendPaise = entries.reduce((sum, item) => sum + item.amount_paise, 0);
  const projectedSpendPaise = currentSpendPaise + amountPaise;
  return {
    allowed: projectedSpendPaise <= capPaise,
    currentSpendPaise,
    projectedSpendPaise,
    capPaise,
    remainingPaise: Math.max(capPaise - currentSpendPaise, 0),
  };
}

const reserveTransaction = db.transaction((principalId, amountPaise, capPaise, windowMs, maxCount) => {
  const now = Date.now();
  const entries = inWindow(principalId, windowMs, now);
  const currentSpendPaise = entries.reduce((sum, item) => sum + item.amount_paise, 0);
  const projectedSpend = currentSpendPaise + amountPaise;
  const projectedCount = entries.length + 1;
  const effectiveMaxCount = maxCount || DEFAULT_MAX_COUNT_PER_WINDOW;
  if (projectedSpend > capPaise) {
    throw new VelocityExceededError(
      `Velocity spend cap breached: ${currentSpendPaise}+${amountPaise} = ${projectedSpend} > ${capPaise}`,
      { currentSpendPaise, amountPaise, projectedSpend, capPaise, reason: 'spend' }
    );
  }
  if (projectedCount > effectiveMaxCount) {
    throw new VelocityExceededError(
      `Velocity count cap breached: ${entries.length}+1 = ${projectedCount} > ${effectiveMaxCount}`,
      { currentCount: entries.length, projectedCount, maxCount: effectiveMaxCount, reason: 'count' }
    );
  }
  const reservationId = crypto.randomUUID();
  db.prepare(
    'INSERT INTO velocity_ledger (reservation_id, principal_id, amount_paise, timestamp_ms, provisional) VALUES (?, ?, ?, ?, 1)'
  ).run(reservationId, principalId, amountPaise, now);
  return reservationId;
});

async function reserveSpend(principalId, amountPaise, capPaise, windowMs, maxCount) {
  assertPrincipalId(principalId);
  assertPositiveInteger(amountPaise, 'amountPaise');
  assertPositiveInteger(capPaise, 'capPaise');
  assertPositiveInteger(windowMs, 'windowMs');
  return reserveTransaction(principalId, amountPaise, capPaise, windowMs, maxCount);
}

function commitSpend(_principalId, reservationId) {
  if (reservationId) db.prepare('UPDATE velocity_ledger SET provisional = 0 WHERE reservation_id = ?').run(reservationId);
}

function releaseSpend(_principalId, reservationId) {
  if (reservationId) db.prepare('DELETE FROM velocity_ledger WHERE reservation_id = ? AND provisional = 1').run(reservationId);
}

function recordSpend(principalId, amountPaise) {
  assertPrincipalId(principalId);
  assertPositiveInteger(amountPaise, 'amountPaise');
  const reservationId = crypto.randomUUID();
  const timestamp = Date.now();
  db.prepare(
    'INSERT INTO velocity_ledger (reservation_id, principal_id, amount_paise, timestamp_ms, provisional) VALUES (?, ?, ?, ?, 0)'
  ).run(reservationId, principalId, amountPaise, timestamp);
  return { principalId, amountPaise, timestamp };
}

function resetLedger() {
  db.exec('DELETE FROM velocity_ledger;');
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
