'use strict';

/**
 * Small SQLite-backed persistence boundary for financial workflow state.
 *
 * A checkout object remains ergonomic for route code, but every top-level
 * mutation is synchronously persisted. SQLite's WAL mode (configured in db.js)
 * gives this single-node deployment restart safety and transactional writes.
 * Horizontal deployments should point every instance at the same managed
 * database; an in-process Map is intentionally not part of this design.
 */

const db = require('../db');

function isoNow() {
  return new Date().toISOString();
}

function serializeSession(session) {
  const plain = {};
  for (const key of Object.keys(session)) plain[key] = session[key];
  return JSON.stringify(plain);
}

function persistSession(session) {
  const stamp = session.updatedAt || isoNow();
  db.prepare(
    `INSERT INTO checkout_sessions (session_id, state, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         state = excluded.state,
         data_json = excluded.data_json,
         updated_at = excluded.updated_at`
  ).run(session.sessionId, session.state, serializeSession(session), session.createdAt || stamp, stamp);
}

function hydrate(row) {
  if (!row) return null;
  let session;
  try {
    session = JSON.parse(row.data_json);
  } catch {
    throw new Error(`Corrupt persisted checkout session ${row.session_id}`);
  }
  // A proxy preserves existing route ergonomics while ensuring direct
  // assignment and Object.assign() can't accidentally become process-local.
  return new Proxy(session, {
    set(target, property, value) {
      target[property] = value;
      persistSession(target);
      return true;
    },
    deleteProperty(target, property) {
      delete target[property];
      persistSession(target);
      return true;
    },
  });
}

function createSessionStore() {
  return Object.freeze({
    get(sessionId) {
      return hydrate(db.prepare('SELECT * FROM checkout_sessions WHERE session_id = ?').get(sessionId));
    },
    set(_sessionId, session) {
      persistSession(session);
      return this;
    },
    values() {
      return db.prepare('SELECT * FROM checkout_sessions ORDER BY created_at').all().map(hydrate).values();
    },
    clear() {
      db.exec('DELETE FROM checkout_locks; DELETE FROM checkout_responses; DELETE FROM payment_attempts; DELETE FROM checkout_sessions;');
    },
  });
}

function getCompletionResponse(sessionId, idempotencyKey) {
  const row = db.prepare(
    'SELECT status_code, response_json FROM checkout_responses WHERE session_id = ? AND idempotency_key = ?'
  ).get(sessionId, idempotencyKey);
  if (!row) return null;
  return { statusCode: row.status_code, body: JSON.parse(row.response_json) };
}

function recordCompletionResponse(sessionId, idempotencyKey, statusCode, body) {
  db.prepare(
    `INSERT INTO checkout_responses (session_id, idempotency_key, status_code, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, idempotency_key) DO NOTHING`
  ).run(sessionId, idempotencyKey, statusCode, JSON.stringify(body), isoNow());
  return getCompletionResponse(sessionId, idempotencyKey);
}

/** Acquire a database-global checkout mutex. Works across app processes. */
function tryAcquireCheckoutLock(sessionId, idempotencyKey) {
  // A crash can strand a lock before a payment attempt is persisted. Expiring
  // it is safe: once an attempt exists, its unique session/receipt row remains
  // the stronger duplicate-write barrier and forces reconciliation.
  db.prepare("DELETE FROM checkout_locks WHERE acquired_at < datetime('now', '-5 minutes')").run();
  const info = db.prepare(
    `INSERT INTO checkout_locks (session_id, idempotency_key, acquired_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO NOTHING`
  ).run(sessionId, idempotencyKey, isoNow());
  return info.changes === 1;
}

function findSessionByRazorpayReference({ orderId, paymentLinkId }) {
  let row = null;
  if (orderId) {
    row = db.prepare("SELECT * FROM checkout_sessions WHERE json_extract(data_json, '$.razorpayOrderId') = ?")
      .get(orderId);
  }
  if (!row && paymentLinkId) {
    row = db.prepare("SELECT * FROM checkout_sessions WHERE json_extract(data_json, '$.razorpayPaymentLinkId') = ?")
      .get(paymentLinkId);
  }
  return hydrate(row);
}

function releaseCheckoutLock(sessionId, idempotencyKey) {
  db.prepare('DELETE FROM checkout_locks WHERE session_id = ? AND idempotency_key = ?')
    .run(sessionId, idempotencyKey);
}

function getPaymentAttempt(sessionId) {
  return db.prepare('SELECT * FROM payment_attempts WHERE session_id = ?').get(sessionId) || null;
}

function beginPaymentAttempt({ sessionId, idempotencyKey, kind, receipt, amountPaise, currency }) {
  const existing = getPaymentAttempt(sessionId);
  if (existing) return existing;
  const stamp = isoNow();
  db.prepare(
    `INSERT INTO payment_attempts
       (session_id, idempotency_key, kind, receipt, amount_paise, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
  ).run(sessionId, idempotencyKey, kind, receipt, amountPaise, currency, stamp, stamp);
  return getPaymentAttempt(sessionId);
}

function setPaymentAttempt(sessionId, status, { razorpayId = null, error = null } = {}) {
  db.prepare(
    `UPDATE payment_attempts
        SET status = ?, razorpay_id = COALESCE(?, razorpay_id), error_json = ?, updated_at = ?
      WHERE session_id = ?`
  ).run(status, razorpayId, error ? JSON.stringify(error) : null, isoNow(), sessionId);
  return getPaymentAttempt(sessionId);
}

function claimWebhook(event) {
  const info = db.prepare(
    `INSERT INTO webhook_inbox (event_id, event_type, payload_json, received_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`
  ).run(event.id, event.event || 'unknown', JSON.stringify(event), isoNow());
  return info.changes === 1;
}

function completeWebhook(eventId, error = null) {
  db.prepare(
    'UPDATE webhook_inbox SET processed_at = ?, processing_error = ? WHERE event_id = ?'
  ).run(isoNow(), error ? String(error) : null, eventId);
}

function resetDurableCommerceForTests() {
  db.exec(`DELETE FROM checkout_locks; DELETE FROM checkout_responses; DELETE FROM payment_attempts; DELETE FROM checkout_sessions;
           DELETE FROM velocity_ledger; DELETE FROM webhook_inbox;`);
}

module.exports = {
  createSessionStore,
  persistSession,
  getCompletionResponse,
  recordCompletionResponse,
  tryAcquireCheckoutLock,
  releaseCheckoutLock,
  findSessionByRazorpayReference,
  getPaymentAttempt,
  beginPaymentAttempt,
  setPaymentAttempt,
  claimWebhook,
  completeWebhook,
  resetDurableCommerceForTests,
};
