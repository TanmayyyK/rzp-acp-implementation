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
const { transitionSession } = require('../lib/sessionStateMachine');
const { verifyRazorpaySignature } = require('../lib/verifyRazorpaySignature');
// Shared hash-chained audit trail (ADR-005). A verified, first-seen webhook is a
// real transaction event, so record it here — this is what surfaces it in the
// dashboard Inspector's feed instead of it vanishing into console.log.
const { sharedAuditLog, EventType, Actor } = require('../lib/auditLog');
const { claimWebhook, completeWebhook, findSessionByRazorpayReference, setPaymentAttempt } = require('../lib/durableCommerceStore');
const { commitSpend, releaseSpend } = require('../lib/velocityTracker');


const router = express.Router();

// Track processed event IDs for idempotent webhook handling (ADR-007).
// In production, swap for Redis/Postgres.
const processedEventIds = new Set();

router.post('/', (req, res) => {
  let event;
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
    event = JSON.parse(rawBody.toString('utf8'));

    // Idempotency — deduplicate on event.id (ADR-007)
    if (!event.id || !claimWebhook(event)) {
      return res.status(200).json({ status: 'already_processed' });
    }
    processedEventIds.add(event.id);

    // Audit the verified, first-seen webhook on the shared chain (best-effort
    // session correlation from the entity notes). Placed after the idempotency
    // guard so a duplicate delivery does not double-log.
    const entity =
      (event.payload && event.payload.order && event.payload.order.entity) ||
      (event.payload && event.payload.payment && event.payload.payment.entity) ||
      null;
    sharedAuditLog.append({
      session_id: entity && entity.notes ? entity.notes.session_id || null : null,
      actor: Actor.RAZORPAY,
      event_type: EventType.WEBHOOK_RECEIVED,
      payload: { event: event.event, id: event.id },
    });

    // Dispatch by event type
    const checkoutRouter = require('./checkout');
    const sessionsMap = checkoutRouter._sessions;

    switch (event.event) {
      case 'order.paid': {
        const orderEntity = event.payload.order.entity;
        const sessionId = orderEntity.notes && orderEntity.notes.session_id;
        
        const session = (sessionId ? sessionsMap.get(sessionId) : null) ||
          findSessionByRazorpayReference({ orderId: orderEntity.id });
        if (session && ['CREATED', 'CONFIRMED'].includes(session.state)) {
          if (session.state === 'CREATED') {
            Object.assign(session, transitionSession(session, 'CONFIRMED'));
          }
          Object.assign(session, transitionSession(session, 'PAID'));
          session.razorpayOrderId = orderEntity.id; // Catch up in case the webhook beat the POST /complete response
          if (session.reservationId) {
            commitSpend(session.reservationPrincipalId, session.reservationId);
            session.reservationId = null;
            session.reservationPrincipalId = null;
          }
          setPaymentAttempt(session.sessionId, 'PAID', { razorpayId: orderEntity.id });
          sharedAuditLog.append({
            session_id: session.sessionId,
            actor: Actor.RAZORPAY,
            event_type: EventType.STATE_TRANSITION,
            payload: { from: 'CONFIRMED', to: 'PAID', source_event: event.id },
          });
        } else if (!session) {
          console.warn(`[Webhook] Session not found for order ${orderEntity.id}`);
        }
        break;
      }
      case 'payment.captured': {
        const paymentEntity = event.payload.payment.entity;
        const sessionId = paymentEntity.notes && paymentEntity.notes.session_id;
        
        const session = (sessionId ? sessionsMap.get(sessionId) : null) ||
          findSessionByRazorpayReference({
            orderId: paymentEntity.order_id,
            paymentLinkId: paymentEntity.invoice_id,
          });
        if (session && ['CREATED', 'CONFIRMED'].includes(session.state)) {
          if (session.state === 'CREATED') {
            Object.assign(session, transitionSession(session, 'CONFIRMED'));
          }
          Object.assign(session, transitionSession(session, 'PAID'));
          session.razorpayPaymentId = paymentEntity.id;
          if (paymentEntity.order_id) {
            session.razorpayOrderId = paymentEntity.order_id;
          } else {
            session.razorpayPaymentLinkId = paymentEntity.invoice_id; // Payment links use invoice_id internally
          }
          if (session.reservationId) {
            commitSpend(session.reservationPrincipalId, session.reservationId);
            session.reservationId = null;
            session.reservationPrincipalId = null;
          }
          setPaymentAttempt(session.sessionId, 'PAID', { razorpayId: paymentEntity.order_id || paymentEntity.invoice_id || paymentEntity.id });
          sharedAuditLog.append({
            session_id: session.sessionId,
            actor: Actor.RAZORPAY,
            event_type: EventType.STATE_TRANSITION,
            payload: { to: 'PAID', source_event: event.id },
          });
        } else if (!session) {
          console.warn(`[Webhook] Session not found for payment ${paymentEntity.id}`);
        }
        break;
      }
      case 'payment.failed': {
        const paymentEntity = event.payload && event.payload.payment && event.payload.payment.entity;
        const sessionId = paymentEntity && paymentEntity.notes && paymentEntity.notes.session_id;
        const session = (sessionId ? sessionsMap.get(sessionId) : null) ||
          findSessionByRazorpayReference({
            orderId: paymentEntity && paymentEntity.order_id,
            paymentLinkId: paymentEntity && paymentEntity.invoice_id,
          });
        if (session && !['PAID', 'COMPLETED', 'CANCELLED', 'FAILED'].includes(session.state)) {
          const from = session.state;
          Object.assign(session, transitionSession(session, 'FAILED'));
          session.failure = {
            code: paymentEntity.error_code || 'PAYMENT_FAILED',
            description: paymentEntity.error_description || 'Razorpay reported a failed payment',
            payment_id: paymentEntity.id || null,
            event_id: event.id,
            at: new Date().toISOString(),
          };
          if (session.reservationId) {
            releaseSpend(session.reservationPrincipalId, session.reservationId);
            session.reservationId = null;
            session.reservationPrincipalId = null;
          }
          setPaymentAttempt(session.sessionId, 'FAILED', { error: session.failure });
          sharedAuditLog.append({
            session_id: session.sessionId,
            actor: Actor.RAZORPAY,
            event_type: EventType.FAILURE,
            payload: { from, to: 'FAILED', source_event: event.id, failure: session.failure },
          });
        }
        break;
      }
      default:
    }

    completeWebhook(event.id);
    res.status(200).json({ status: 'success' });
  } catch (error) {
    if (typeof event !== 'undefined' && event && event.id) completeWebhook(event.id, error.message);
    console.error('Error processing Razorpay webhook:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Exported for testing
router._processedEventIds = processedEventIds;

module.exports = router;
