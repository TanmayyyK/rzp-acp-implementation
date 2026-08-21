'use strict';

/**
 * Webhook route — Razorpay → merchant server.
 *
 * The raw body is preserved as a Buffer by the rawBody middleware
 * (mounted in server.js BEFORE express.json()) so the HMAC-SHA256
 * signature can be computed on the exact bytes Razorpay signed.
 *
 * Uses the Sonnet-drafted verifyRazorpaySignature module for
 * constant-time comparison (ADR-007).
 */

const express = require('express');
const { verifyRazorpaySignature } = require('../lib/verifyRazorpaySignature');
const config = require('../config');

const router = express.Router();

// Track processed event IDs for idempotent webhook handling (ADR-007).
// In production, swap for Redis/Postgres.
const processedEventIds = new Set();

router.post('/', (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    const razorpaySignature = req.headers['x-razorpay-signature'];

    if (!webhookSecret) {
      console.error('RAZORPAY_WEBHOOK_SECRET is not configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    if (!razorpaySignature) {
      return res.status(400).json({ error: 'Missing x-razorpay-signature header' });
    }

    // req.body is a Buffer here (express.raw parsed it before express.json)
    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody)) {
      console.error('Webhook body is not a Buffer — raw body middleware may be misconfigured');
      return res.status(500).json({ error: 'Internal body parsing error' });
    }

    const valid = verifyRazorpaySignature(rawBody, razorpaySignature, webhookSecret);

    if (!valid) {
      console.warn('Invalid Razorpay webhook signature detected.');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Signature valid — parse JSON
    const event = JSON.parse(rawBody.toString('utf8'));
    console.log(`[Webhook] Valid event received: ${event.event} [ID: ${event.id}]`);

    // Idempotency — deduplicate on event.id (ADR-007)
    if (processedEventIds.has(event.id)) {
      console.log(`[Webhook] Duplicate event ${event.id}, skipping.`);
      return res.status(200).json({ status: 'already_processed' });
    }
    processedEventIds.add(event.id);

    // Dispatch by event type
    switch (event.event) {
      case 'order.paid':
        console.log(`[Webhook] Order paid: ${event.payload.order.entity.id}`);
        // TODO: Drive state machine CONFIRMED → PAID (Day 4+)
        break;
      case 'payment.captured':
        console.log(`[Webhook] Payment captured: ${event.payload.payment.entity.id}`);
        break;
      case 'payment.failed':
        console.log(`[Webhook] Payment failed: ${event.payload.payment.entity.id}`);
        // TODO: Drive state machine → FAILED (Day 12)
        break;
      default:
        console.log(`[Webhook] Unhandled event type: ${event.event}`);
    }

    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error processing Razorpay webhook:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Exported for testing
router._processedEventIds = processedEventIds;

module.exports = router;
