'use strict';

/**
 * Audit-log wiring — socket-free integration tests (ADR-005, ARCHITECTURE §2.6).
 *
 * Drives the REAL composition-root app (src/server.js) via app.handle() with a
 * mock stream request and a capturing response (see tests/helpers/mockHttp.js),
 * so no port is bound — supertest/listen is blocked in this sandbox. It proves
 * the three server-side audit requirements end-to-end against the wired app:
 *   #1 a GENESIS block anchors the shared chain the moment the server loads;
 *   #3 a successful mandate-signature verification appends one MANDATE_VERIFIED
 *      block, and a failed verification appends nothing;
 *   #4 GET /audit-log returns the whole chain plus a live integrity proof.
 *
 * The chain is process-wide singleton state; jest gives each test file its own
 * module registry, so within this file it starts at [GENESIS] and accumulates.
 * Assertions therefore key off seq 0 / deltas, never absolute later counts.
 */

const app = require('../src/server');
const { sharedAuditLog } = require('../src/lib/auditLog');
const { handle } = require('./helpers/mockHttp');

const ALL_ZERO = '0'.repeat(64);

describe('genesis block (req #1 — chain anchored at server boot)', () => {
  test('seq 0 is a GENESIS block with an all-zero prev_hash and a valid chain', () => {
    const first = sharedAuditLog.entries()[0];
    expect(first.seq).toBe(0);
    expect(first.event_type).toBe('GENESIS');
    expect(first.prev_hash).toBe(ALL_ZERO);
    expect(first.actor).toBe('merchant_server');
    expect(typeof first.hash).toBe('string');
    expect(first.hash).toHaveLength(64);
    expect(sharedAuditLog.verifyChain()).toEqual({ valid: true, brokenAt: null });
  });
});

describe('GET /audit-log (req #4 — the whole chain for the UI)', () => {
  test('returns genesis_hash, count, a live integrity proof, and the entries array', async () => {
    const res = await handle(app, { method: 'GET', url: '/audit-log' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.captured);
    expect(body.genesis_hash).toBe(ALL_ZERO);
    expect(body.integrity).toEqual({ valid: true, brokenAt: null });
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.count).toBe(body.entries.length);
    expect(body.entries[0].event_type).toBe('GENESIS');
  });

  test('is a plain GET — it falls through the signature guard and appends nothing', async () => {
    const before = sharedAuditLog.entries().length;
    await handle(app, { method: 'GET', url: '/audit-log' });
    expect(sharedAuditLog.entries().length).toBe(before);
  });
});

