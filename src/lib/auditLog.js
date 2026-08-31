'use strict';

/**
 * auditLog.js — hash-chained, append-only audit trail (ADR-005, ARCHITECTURE §2.6).
 *
 * Every entry embeds the previous entry's `hash` as its `prev_hash`, and its own
 * `hash = SHA256( JCS(entry without the "hash" field) )`. Because `prev_hash` is
 * inside the hashed bytes, editing entry n silently breaks the hash of entry n
 * AND the prev_hash linkage of entry n+1 — so a `verifyChain()` walk detects the
 * first tampered link in O(n). The genesis entry's `prev_hash` is 64 zeros.
 *
 * Canonicalization is delegated to the project's existing RFC 8785 (JCS)
 * canonicalizer in jcs-hmac.js — the same one the mandate signatures use — so the
 * audit hash and the mandate signatures agree on byte-exact serialization.
 *
 * The running merchant uses a SQLite-backed append-only chain; the in-memory
 * factory below exists only for isolated unit tests. This is tamper-*evident*,
 * not tamper-*proof*: a database administrator can rewrite history unless the
 * deployment exports signed checkpoints to an independent retention system.
 */

const crypto = require('crypto');
const { canonicalize } = require('../../jcs-hmac');
const db = require('../db');

/** Genesis link: the prev_hash of the very first entry. */
const GENESIS_PREV_HASH = '0'.repeat(64);

/** Event types and actors, per ARCHITECTURE.md §2.6. Frozen for safe reuse. */
const EventType = Object.freeze({
  GENESIS: 'GENESIS',
  AGENT_REASONING: 'AGENT_REASONING',
  TOOL_CALL: 'TOOL_CALL',
  MANDATE_ISSUED: 'MANDATE_ISSUED',
  MANDATE_VERIFIED: 'MANDATE_VERIFIED',
  GUARDRAIL_DECISION: 'GUARDRAIL_DECISION',
  MONEY_ACTION: 'MONEY_ACTION',
  WEBHOOK_RECEIVED: 'WEBHOOK_RECEIVED',
  STATE_TRANSITION: 'STATE_TRANSITION',
  FAILURE: 'FAILURE',
});

const Actor = Object.freeze({
  BUYER_AGENT: 'buyer_agent',
  MERCHANT_SERVER: 'merchant_server',
  RAZORPAY: 'razorpay',
  HUMAN: 'human',
  GUARDRAIL: 'guardrail',
});

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** hash = SHA256(JCS(entry)), where `entry` already excludes the `hash` field. */
function computeHash(entryWithoutHash) {
  return sha256Hex(canonicalize(entryWithoutHash));
}

/**
 * Creates an append-only, hash-chained audit log.
 * @returns {{
 *   append: (partial: object) => object,
 *   entries: () => object[],
 *   verifyChain: () => { valid: boolean, brokenAt: number|null },
 *   reset: () => void,
 * }}
 */
function createAuditLog() {
  const log = [];

  /**
   * Append one entry. The caller supplies the semantic fields
   * (`actor`, `event_type`, `payload`, optional `session_id`); this function
   * assigns `seq`, `entry_id`, `timestamp`, `prev_hash`, and the computed `hash`.
   */
  function append(partial = {}) {
    const prev = log[log.length - 1];
    const entry = {
      seq: log.length,
      entry_id: partial.entry_id || `log_${crypto.randomBytes(8).toString('hex')}`,
      timestamp: partial.timestamp || new Date().toISOString(),
      session_id: partial.session_id === undefined ? null : partial.session_id,
      actor: partial.actor || Actor.MERCHANT_SERVER,
      event_type: partial.event_type,
      payload: partial.payload === undefined ? {} : partial.payload,
      prev_hash: prev ? prev.hash : GENESIS_PREV_HASH,
    };
    entry.hash = computeHash(entry);
    log.push(entry);
    return entry;
  }

  /**
   * Walk the chain, recomputing each hash and checking each prev_hash linkage.
   * Returns the seq of the first broken entry, or { valid: true } if intact.
   */
  function verifyChain() {
    let expectedPrev = GENESIS_PREV_HASH;
    for (const entry of log) {
      if (entry.prev_hash !== expectedPrev) {
        return { valid: false, brokenAt: entry.seq };
      }
      const { hash, ...rest } = entry;
      if (computeHash(rest) !== hash) {
        return { valid: false, brokenAt: entry.seq };
      }
      expectedPrev = entry.hash;
    }
    return { valid: true, brokenAt: null };
  }

  return {
    append,
    // Shallow copy of the array (callers can't push/splice internal state), but
    // the entry objects themselves are live references — mutating one is exactly
    // the tampering that verifyChain() is designed to catch.
    entries: () => log.slice(),
    verifyChain,
    reset: () => {
      log.length = 0;
    },
  };
}

/**
 * Database-backed variant used by the running merchant. The public factory
 * above stays isolated for unit tests; production evidence is never held in a
 * process-local array. Sequence allocation and append occur in one SQLite
 * transaction, preserving a single tamper-evident chain across restarts.
 */
function createPersistentAuditLog() {
  const append = db.transaction((partial = {}) => {
    const last = db.prepare('SELECT seq, entry_json FROM audit_events ORDER BY seq DESC LIMIT 1').get();
    const previous = last ? JSON.parse(last.entry_json) : null;
    const entry = {
      seq: last ? last.seq + 1 : 0,
      entry_id: partial.entry_id || `log_${crypto.randomBytes(8).toString('hex')}`,
      timestamp: partial.timestamp || new Date().toISOString(),
      session_id: partial.session_id === undefined ? null : partial.session_id,
      actor: partial.actor || Actor.MERCHANT_SERVER,
      event_type: partial.event_type,
      payload: partial.payload === undefined ? {} : partial.payload,
      prev_hash: previous ? previous.hash : GENESIS_PREV_HASH,
    };
    entry.hash = computeHash(entry);
    db.prepare('INSERT INTO audit_events (seq, entry_json, created_at) VALUES (?, ?, ?)')
      .run(entry.seq, JSON.stringify(entry), entry.timestamp);
    return entry;
  });

  function entries() {
    return db.prepare('SELECT entry_json FROM audit_events ORDER BY seq').all().map((row) => JSON.parse(row.entry_json));
  }

  function verifyChain() {
    let expectedPrev = GENESIS_PREV_HASH;
    for (const entry of entries()) {
      if (entry.prev_hash !== expectedPrev) return { valid: false, brokenAt: entry.seq };
      const { hash, ...rest } = entry;
      if (computeHash(rest) !== hash) return { valid: false, brokenAt: entry.seq };
      expectedPrev = entry.hash;
    }
    return { valid: true, brokenAt: null };
  }

  return {
    append,
    entries,
    verifyChain,
    reset: () => db.exec('DELETE FROM audit_events;'),
  };
}

/**
 * The one server-wide audit chain (ADR-005). Created once at module load —
 * i.e. when the server process starts — and immediately seeded with an
 * explicit GENESIS block so index 0 is always the chain's anchor rather than
 * the first business event. Every server-side tap (mandate verification,
 * money actions) and, in a single-process deployment, the MCP tool taps all
 * append to THIS instance; `GET /audit-log` serves it.
 *
 * Durable in SQLite for the single-node deployment. Note the process boundary:
 * the MCP stdio server (src/mcp/server.js) must call the HTTP merchant surface
 * for its audit events to be visible to the web process.
 */
const sharedAuditLog = createPersistentAuditLog();
if (sharedAuditLog.entries().length === 0) {
  sharedAuditLog.append({
    actor: Actor.MERCHANT_SERVER,
    event_type: EventType.GENESIS,
    payload: { note: 'audit chain genesis — durable merchant audit chain' },
  });
}

module.exports = {
  createAuditLog,
  createPersistentAuditLog,
  sharedAuditLog,
  computeHash,
  GENESIS_PREV_HASH,
  EventType,
  Actor,
};
