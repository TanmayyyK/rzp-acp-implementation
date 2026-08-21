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
    const checkoutRouter = require('./checkout');
    const sessionsMap = checkoutRouter._sessions;

    switch (event.event) {
      case 'order.paid': {
        const orderEntity = event.payload.order.entity;
        const sessionId = orderEntity.notes && orderEntity.notes.session_id;
        console.log(`[Webhook] Order paid: ${orderEntity.id}`);
        
        const session = sessionId ? sessionsMap.get(sessionId) : null;
        if (session && ['CREATED', 'PROCESSING', 'CONFIRMED'].includes(session.state)) {
          session.state = 'PAID';
          session.razorpayOrderId = orderEntity.id; // Catch up in case the webhook beat the POST /complete response
          session.updatedAt = new Date().toISOString();
          console.log(`[Webhook] Session ${sessionId} transitioned to PAID`);
        } else if (!session) {
          console.warn(`[Webhook] Session not found for order ${orderEntity.id}`);
        }
        break;
      }
      case 'payment.captured': {
        const paymentEntity = event.payload.payment.entity;
        const sessionId = paymentEntity.notes && paymentEntity.notes.session_id;
        console.log(`[Webhook] Payment captured: ${paymentEntity.id}`);
        
        const session = sessionId ? sessionsMap.get(sessionId) : null;
        if (session && ['CREATED', 'PROCESSING', 'CONFIRMED'].includes(session.state)) {
          session.state = 'PAID';
          session.razorpayPaymentId = paymentEntity.id;
          if (paymentEntity.order_id) {
            session.razorpayOrderId = paymentEntity.order_id;
          } else {
            session.razorpayPaymentLinkId = paymentEntity.invoice_id; // Payment links use invoice_id internally
          }
          session.updatedAt = new Date().toISOString();
          console.log(`[Webhook] Session ${sessionId} transitioned to PAID with payment ${paymentEntity.id}`);
        } else if (!session) {
          console.warn(`[Webhook] Session not found for payment ${paymentEntity.id}`);
        }
        break;
      }
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
