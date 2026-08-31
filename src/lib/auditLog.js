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
 * The store is in-memory (single-writer, demo scale), matching the checkout
 * session store and idempotency store; it is swappable for a durable log later.
 * This is tamper-*evident*, not tamper-*proof*: a single writer needs no
 * consensus, and verifyChain() is what proves the log was not doctored.
 */

const crypto = require('crypto');
const { canonicalize } = require('../../jcs-hmac');

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
 * The one server-wide audit chain (ADR-005). Created once at module load —
 * i.e. when the server process starts — and immediately seeded with an
 * explicit GENESIS block so index 0 is always the chain's anchor rather than
 * the first business event. Every server-side tap (mandate verification,
 * money actions) and, in a single-process deployment, the MCP tool taps all
 * append to THIS instance; `GET /audit-log` serves it.
 *
 * In-memory and single-writer, matching the checkout session + idempotency
 * stores. Note the process boundary: the MCP stdio server (src/mcp/server.js)
 * runs as a separate process from the merchant HTTP server, so its tool taps
 * only land in this shared chain when the two run in one process (as they do
 * in-process during tests, and can in a combined demo host). Swappable for a
 * durable/shared store later without touching any call site.
 */
const sharedAuditLog = createAuditLog();
sharedAuditLog.append({
  actor: Actor.MERCHANT_SERVER,
  event_type: EventType.GENESIS,
  payload: { note: 'audit chain genesis — server boot' },
});

module.exports = {
  createAuditLog,
  sharedAuditLog,
  computeHash,
  GENESIS_PREV_HASH,
  EventType,
  Actor,
};
