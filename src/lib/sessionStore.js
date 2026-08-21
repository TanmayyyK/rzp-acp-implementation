'use strict';

/**
 * In-memory checkout session store (Day 3).
 *
 * A process-local Map keyed by session_id. Deliberately ephemeral —
 * sessions vanish on restart. This is the "for now" store; it will be
 * swapped for a durable backend (Redis/Postgres) once the ACP checkout
 * lifecycle stabilises.
 *
 * It also memoises POST /complete responses per (session_id,
 * Idempotency-Key) so a retried completion replays the original
 * response instead of acting twice (ADR-007).
 */

const crypto = require('crypto');

const sessions = new Map(); // session_id -> session record
const idempotency = new Map(); // `${session_id}:${key}` -> { statusCode, body }

/**
 * Generates a prefixed, collision-resistant id, e.g. genId('acp_sess_').
 * @param {string} prefix
 * @returns {string}
 */
function genId(prefix) {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

function saveSession(record) {
  sessions.set(record.session_id, record);
  return record;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function rememberIdempotent(sessionId, key, response) {
  idempotency.set(`${sessionId}:${key}`, response);
}

function recallIdempotent(sessionId, key) {
  return idempotency.get(`${sessionId}:${key}`) || null;
}

/** Test-only: clear all state between suites. */
function _reset() {
  sessions.clear();
  idempotency.clear();
}

module.exports = {
  genId,
  saveSession,
  getSession,
  rememberIdempotent,
  recallIdempotent,
  _reset,
};
