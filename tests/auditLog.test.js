'use strict';

/**
 * Unit tests for the hash-chained audit log (src/lib/auditLog.js), per ADR-005
 * and ARCHITECTURE §2.6. Pure and socket-free.
 */

const {
  createAuditLog,
  computeHash,
  GENESIS_PREV_HASH,
  EventType,
  Actor,
} = require('../src/lib/auditLog');

describe('createAuditLog — entry shape (ARCHITECTURE §2.6)', () => {
  test('a GUARDRAIL_DECISION entry carries every §2.6 field', () => {
    const log = createAuditLog();
    const entry = log.append({
      session_id: 'acp_sess_1',
      actor: Actor.GUARDRAIL,
      event_type: EventType.GUARDRAIL_DECISION,
      payload: { check: 'category_allowlist', outcome: 'PASS', detail: {} },
    });
    expect(Object.keys(entry).sort()).toEqual(
      ['actor', 'entry_id', 'event_type', 'hash', 'payload', 'prev_hash', 'seq', 'session_id', 'timestamp'].sort()
    );
    expect(entry.seq).toBe(0);
    expect(entry.actor).toBe('guardrail');
    expect(entry.event_type).toBe('GUARDRAIL_DECISION');
    expect(entry.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('sensible defaults: seq, generated entry_id, ISO timestamp, null session, merchant actor', () => {
    const log = createAuditLog();
    const entry = log.append({ event_type: EventType.STATE_TRANSITION });
    expect(entry.seq).toBe(0);
    expect(entry.entry_id).toMatch(/^log_[0-9a-f]{16}$/);
    expect(() => new Date(entry.timestamp).toISOString()).not.toThrow();
    expect(entry.session_id).toBeNull();
    expect(entry.actor).toBe(Actor.MERCHANT_SERVER);
    expect(entry.payload).toEqual({});
  });
});

describe('hash chaining', () => {
  test('genesis prev_hash is 64 zeros', () => {
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
    const log = createAuditLog();
    expect(log.append({ event_type: EventType.TOOL_CALL }).prev_hash).toBe('0'.repeat(64));
  });

  test('seq increments and each prev_hash equals the previous entry hash', () => {
    const log = createAuditLog();
    const a = log.append({ event_type: EventType.MANDATE_ISSUED });
    const b = log.append({ event_type: EventType.MANDATE_VERIFIED });
    const c = log.append({ event_type: EventType.MONEY_ACTION });
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    expect(b.prev_hash).toBe(a.hash);
    expect(c.prev_hash).toBe(b.hash);
  });

  test('hash = sha256(JCS(entry without the hash field))', () => {
    const log = createAuditLog();
    const entry = log.append({ event_type: EventType.WEBHOOK_RECEIVED, payload: { z: 1, a: 2 } });
    const { hash, ...rest } = entry;
    expect(computeHash(rest)).toBe(hash);
  });

  test('two logs with identical inputs produce identical hashes (deterministic canonicalization)', () => {
    const fixed = {
      entry_id: 'log_fixed', timestamp: '2026-08-22T00:00:00.000Z',
      session_id: 's1', actor: Actor.MERCHANT_SERVER,
      event_type: EventType.MONEY_ACTION, payload: { amount_paise: 179900, currency: 'INR' },
    };
    const h1 = createAuditLog().append({ ...fixed }).hash;
    const h2 = createAuditLog().append({ ...fixed }).hash;
    expect(h1).toBe(h2);
  });
});

describe('verifyChain', () => {
  test('valid on a clean, freshly-built chain', () => {
    const log = createAuditLog();
    for (let i = 0; i < 5; i++) log.append({ event_type: EventType.AGENT_REASONING, payload: { i } });
    expect(log.verifyChain()).toEqual({ valid: true, brokenAt: null });
  });

  test('valid on an empty log', () => {
    expect(createAuditLog().verifyChain()).toEqual({ valid: true, brokenAt: null });
  });

  test('detects a tampered payload at the first broken seq', () => {
    const log = createAuditLog();
    log.append({ event_type: EventType.MONEY_ACTION, payload: { amount_paise: 100 } });
    log.append({ event_type: EventType.MONEY_ACTION, payload: { amount_paise: 200 } });
    log.append({ event_type: EventType.MONEY_ACTION, payload: { amount_paise: 300 } });

    // Tamper with entry 1 in place (entries() returns live entry references).
    log.entries()[1].payload.amount_paise = 999;

    expect(log.verifyChain()).toEqual({ valid: false, brokenAt: 1 });
  });

  test('detects a broken prev_hash linkage', () => {
    const log = createAuditLog();
    log.append({ event_type: EventType.STATE_TRANSITION });
    log.append({ event_type: EventType.STATE_TRANSITION });
    log.entries()[1].prev_hash = '0'.repeat(64);
    expect(log.verifyChain().valid).toBe(false);
    expect(log.verifyChain().brokenAt).toBe(1);
  });
});

describe('entries() and reset()', () => {
  test('entries() returns a copy — callers cannot push/splice internal state', () => {
    const log = createAuditLog();
    log.append({ event_type: EventType.TOOL_CALL });
    const snapshot = log.entries();
    snapshot.push({ bogus: true });
    expect(log.entries()).toHaveLength(1);
  });

  test('reset() empties the log back to genesis', () => {
    const log = createAuditLog();
    log.append({ event_type: EventType.TOOL_CALL });
    log.reset();
    expect(log.entries()).toHaveLength(0);
    expect(log.append({ event_type: EventType.TOOL_CALL }).prev_hash).toBe(GENESIS_PREV_HASH);
  });
});
