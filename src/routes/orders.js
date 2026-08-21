'use strict';

/**
 * Orders route — Razorpay Order creation & Payment Link creation.
 *
 * POST /api/v1/orders          — create a Razorpay Order (1:1 with our ord_)
 * POST /api/v1/orders/link     — create a Razorpay Payment Link (human approval)
 * GET  /api/v1/orders/:id      — fetch a Razorpay Order by id
 */

const express = require('express');
const razorpayClient = require('../lib/razorpayClient');
const config = require('../config');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/v1/orders — create a Razorpay Order
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { amount, currency, receipt, notes } = req.body;

    // Validate required fields
    if (!amount || typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({
        error: {
          code: 'INVALID_AMOUNT',
          message: 'amount must be a positive integer in paise (ADR-004)',
          retriable: false,
        },
      });
    }

    if (!receipt) {
      return res.status(400).json({
        error: {
          code: 'MISSING_RECEIPT',
          message: 'receipt (our internal order id) is required',
          retriable: false,
        },
      });
    }

    const idempotencyKey = req.headers['idempotency-key'];

    const order = await razorpayClient.createOrder({
      amount,
      currency: currency || config.currency,
      receipt,
      notes: notes || {},
      idempotencyKey,
    });

    console.log(`[Orders] Razorpay Order created: ${order.id} (receipt: ${receipt})`);

    res.status(201).json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Orders] Error creating order:', err);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      error: {
        code: 'ORDER_CREATION_FAILED',
        message: err.error?.description || err.message || 'Unknown error',
        retriable: statusCode === 429 || statusCode >= 500,
      },
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/orders/link — create a Razorpay Payment Link (ADR-003)
// ---------------------------------------------------------------------------
router.post('/link', async (req, res) => {
  try {
    const { amount, currency, description, receipt, callback_url, notes } = req.body;

    if (!amount || typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({
        error: {
          code: 'INVALID_AMOUNT',
          message: 'amount must be a positive integer in paise (ADR-004)',
          retriable: false,
        },
      });
    }

    if (!description) {
      return res.status(400).json({
        error: {
          code: 'MISSING_DESCRIPTION',
          message: 'description is required for payment links',
          retriable: false,
        },
      });
    }

    const link = await razorpayClient.createPaymentLink({
      amount,
      currency: currency || config.currency,
      description,
      receipt: receipt || '',
      callbackUrl: callback_url || '',
      notes: notes || {},
    });

    console.log(`[Orders] Payment Link created: ${link.id} (amount: ${amount})`);

    res.status(201).json({
      payment_link_id: link.id,
      short_url: link.short_url,
      amount: link.amount,
      currency: link.currency,
      status: link.status,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Orders] Error creating payment link:', err);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      error: {
        code: 'PAYMENT_LINK_CREATION_FAILED',
        message: err.error?.description || err.message || 'Unknown error',
        retriable: statusCode === 429 || statusCode >= 500,
      },
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/orders/:id — fetch a Razorpay Order
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const order = await razorpayClient.fetchOrder(req.params.id);

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status,
      amount_paid: order.amount_paid,
      amount_due: order.amount_due,
    });
  } catch (err) {
    console.error(`[Orders] Error fetching order ${req.params.id}:`, err);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      error: {
        code: 'ORDER_FETCH_FAILED',
        message: err.error?.description || err.message || 'Unknown error',
        retriable: statusCode === 429 || statusCode >= 500,
      },
    });
  }
});

module.exports = router;
