'use strict';

const app = require('../src/server');
const { sharedAuditLog } = require('../src/lib/auditLog');
const { handle } = require('./helpers/mockHttp');

describe('direct Razorpay ingress is retired', () => {
  test.each(['/api/v1/orders', '/api/v1/orders/link'])('%s cannot create a payment artifact or audit a fake money action', async (url) => {
    const before = sharedAuditLog.entries().length;
    const res = await handle(app, {
      method: 'POST', url, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 99999999, currency: 'USD', receipt: 'attacker-controlled' }),
    });
    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.captured).error.code).toBe('DIRECT_RAZORPAY_INGRESS_RETIRED');
    expect(sharedAuditLog.entries().slice(before).some((entry) => entry.event_type === 'MONEY_ACTION')).toBe(false);
  });
});
