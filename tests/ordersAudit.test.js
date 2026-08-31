'use strict';

/**
 * Orders-route audit tap — socket-free (ADR-005, req #3: "a Razorpay test order
 * is created").
 *
 * The ACP checkout flow audits its Razorpay order/link creation inside
 * checkout.js; this direct REST surface (POST /api/v1/orders and .../link) must
 * do the same, so no Razorpay test order is ever created without a MONEY_ACTION
 * block. razorpayClient is mocked so the route runs without any network call,
 * and the app is driven via app.handle() (no port bound).
 */

jest.mock('../src/lib/razorpayClient', () => ({
  createOrder: jest.fn(async (o) => ({
    id: 'order_rzp_test1',
    amount: o.amount,
    currency: o.currency,
    receipt: o.receipt,
    status: 'created',
  })),
  createPaymentLink: jest.fn(async (o) => ({
    id: 'plink_test1',
    short_url: 'https://rzp.io/i/xyz',
    amount: o.amount,
    currency: o.currency,
    status: 'created',
  })),
  fetchOrder: jest.fn(),
}));

const app = require('../src/server');
const { sharedAuditLog } = require('../src/lib/auditLog');
const { handle } = require('./helpers/mockHttp');

describe('orders route audit tap (req #3 — Razorpay test order created)', () => {
  test('POST /api/v1/orders appends one MONEY_ACTION block for the created order', async () => {
    const before = sharedAuditLog.entries().length;
    const res = await handle(app, {
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 179900, currency: 'INR', receipt: 'ord_internal_1' }),
    });
    expect(res.statusCode).toBe(201);

    const ma = sharedAuditLog.entries().slice(before).filter((e) => e.event_type === 'MONEY_ACTION');
    expect(ma).toHaveLength(1);
    expect(ma[0].actor).toBe('merchant_server');
    expect(ma[0].session_id).toBe('ord_internal_1');
    expect(ma[0].payload.action).toBe('razorpay_order_created');
    expect(ma[0].payload.razorpay_order_id).toBe('order_rzp_test1');
    expect(ma[0].payload.amount_paise).toBe(179900);
    expect(ma[0].payload.currency).toBe('INR');
    expect(sharedAuditLog.verifyChain().valid).toBe(true);
  });

  test('POST /api/v1/orders/link appends a MONEY_ACTION block for the payment link', async () => {
    const before = sharedAuditLog.entries().length;
    const res = await handle(app, {
      method: 'POST',
      url: '/api/v1/orders/link',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: 5000000,
        currency: 'INR',
        description: 'High-value order',
        receipt: 'ord_internal_2',
      }),
    });
    expect(res.statusCode).toBe(201);

    const ma = sharedAuditLog.entries().slice(before).filter((e) => e.event_type === 'MONEY_ACTION');
    expect(ma).toHaveLength(1);
    expect(ma[0].payload.action).toBe('razorpay_payment_link_created');
    expect(ma[0].payload.payment_link_id).toBe('plink_test1');
    expect(ma[0].payload.amount_paise).toBe(5000000);
    expect(ma[0].session_id).toBe('ord_internal_2');
  });

  test('a rejected order (400, no Razorpay call) appends no MONEY_ACTION', async () => {
    const before = sharedAuditLog.entries().length;
    const res = await handle(app, {
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: -5, receipt: 'bad' }), // invalid amount
    });
    expect(res.statusCode).toBe(400);
    const added = sharedAuditLog.entries().slice(before).filter((e) => e.event_type === 'MONEY_ACTION');
    expect(added).toHaveLength(0);
  });
});
