'use strict';

/** The keyless chat surface is intentionally incapable of fabricating commerce. */

const { handle } = require('./helpers/mockHttp');

function loadApp() {
  let app;
  let sharedAuditLog;
  jest.isolateModules(() => {
    app = require('../src/server');
    ({ sharedAuditLog } = require('../src/lib/auditLog'));
  });
  return { app, sharedAuditLog };
}

async function postChat(app, body) {
  const res = await handle(app, {
    method: 'POST', url: '/chat', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, messages: JSON.parse(res.captured) };
}

describe('POST /chat safe preview', () => {
  test('a default purchase creates no receipt, mandate, guardrail decision, or money action', async () => {
    const { app, sharedAuditLog } = loadApp();
    const before = sharedAuditLog.entries().length;
    const { statusCode, messages } = await postChat(app, { message: 'buy a mechanical keyboard', provider: 'stub' });

    expect(statusCode).toBe(200);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'agent' });
    expect(messages[0].content).toMatch(/simulation is disabled/i);
    expect(messages.some((message) => message.role === 'receipt')).toBe(false);

    const added = sharedAuditLog.entries().slice(before);
    expect(added.map((entry) => entry.event_type)).toEqual(['AGENT_REASONING']);
    expect(added.some((entry) => ['MONEY_ACTION', 'MANDATE_ISSUED'].includes(entry.event_type))).toBe(false);
  });
});
