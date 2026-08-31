'use strict';

/**
 * x402 Express router — Multi-Protocol Gateway entry point.
 *
 * This is an adapter, not a second trust core. It normalizes an HTTP-402
 * handshake into internal mandate fields and then asks the same authorization
 * question every money path asks: did the human authorize *this* amount?
 *
 * The x402 payer proof is a crypto-rail artifact. Its format is enforced in
 * x402Adapter (an unsigned or junk proof never reaches this router), but the
 * merchant server is not the verifier of that rail's signature and holds no key
 * that could verify it. Authorization here comes from the human: a live WebAuthn
 * session within their delegation limits, or an ApprovalMandate their own
 * authenticator signed over this exact nonce and amount.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { generateChallenge, translateToInternalMandate, InvalidProtocolError } = require('../adapters/x402Adapter');
const { evaluateDelegation } = require('../lib/delegation');
const { transitionSession } = require('../lib/sessionStateMachine');
const { reserveSpend, commitSpend, releaseSpend, VelocityExceededError } = require('../lib/velocityTracker');
const { sharedAuditLog, EventType, Actor } = require('../lib/auditLog');
const razorpayClient = require('../lib/razorpayClient');
const humanAuth = require('../circle/humanAuthorization');
const webauthn = require('../circle/webauthn');
const db = require('../db');

const DEFAULT_VELOCITY_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_CAP_PAISE = 1000000;

/**
 * The transaction identity an x402 ApprovalMandate is bound to.
 *
 * The server-side session id is minted at submit time, so a client could not
 * sign it in advance. The payment nonce can be: it is unique per payment, comes
 * from our own /x402/checkout challenge, and is already carried in the payload.
 * Binding to it is what stops an approval for one payment being replayed onto
 * another.
 */
function approvalTransactionId(nonce) {
  return `x402:${nonce}`;
}

// GET /x402/checkout
router.get('/checkout', (req, res) => {
  try {
    const cartAmount = parseInt(req.query.cartAmount, 10);
    if (isNaN(cartAmount)) {
      return res.status(400).json({ error: 'cartAmount must be an integer (paise)' });
    }

    const address = req.query.address || '0xMerchantSettlementAddress123';
    const challenge = generateChallenge(cartAmount, address);

    return res.status(402).json(challenge);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// GET /x402/approve/challenge?nonce=&amount=
// The payload a human must sign when their delegation limits do not cover an
// x402 payment. Without this the over-cap path would be unreachable: only the
// human's authenticator can produce the approval, and it needs the server's
// exact bytes to sign.
router.get('/approve/challenge', async (req, res) => {
  try {
    if (!req.session || !req.session.authenticated || !req.session.principal_id) {
      return res.status(401).json({ error: 'Unauthorized: Human WebAuthn session required' });
    }
    const principalId = req.session.principal_id;

    const nonce = typeof req.query.nonce === 'string' ? req.query.nonce.trim() : '';
    const amountPaise = parseInt(req.query.amount, 10);
    if (!nonce) {
      return res.status(400).json({ error: 'nonce is required (the nonce from the /x402/checkout challenge)' });
    }
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      return res.status(400).json({ error: 'amount must be a positive integer (paise)' });
    }

    const credential = humanAuth.getCredential(principalId);
    if (!credential) {
      return res.status(404).json({ error: 'User is not registered for WebAuthn' });
    }

    const { core, challenge } = humanAuth.buildApprovalRequest({
      sessionId: approvalTransactionId(nonce),
      principalId,
      cartMandateId: null,
      amountPaise,
    });
    const options = await webauthn.generateAuthOptions(
      {
        id: principalId,
        username: principalId,
        credentials: [{ id: credential.credentialID, transports: credential.transports }],
      },
      challenge
    );

    return res.json({ approval_mandate: core, webauthn: options, ...options });
  } catch (err) {
    console.error('[x402] Generate approve challenge error:', err);
    return res.status(500).json({ error: 'Failed to generate approval challenge' });
  }
});

// POST /x402/submit (The Trust Core Funnel)
router.post('/submit', async (req, res) => {
  try {
    const payload = req.body;
    
    // HARDENED: Session authentication required. The X-Test-Principal-Id
    // backdoor has been DELETED (Critical 1 from adversarial audit).
    if (!req.session || !req.session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized: Human WebAuthn session required' });
    }
    const principal_id = req.session.principal_id;
    if (!principal_id) {
      return res.status(401).json({ error: 'Unauthorized: missing principal_id in session' });
    }

    // --- Translate x402 payload to internal mandates ---
    let internalMandates;
    try {
      internalMandates = translateToInternalMandate(payload, principal_id);
    } catch (err) {
      if (err instanceof InvalidProtocolError || err.name === 'InvalidProtocolError') {
        sharedAuditLog.append({
          session_id: 'x402_failed',
          actor: Actor.GUARDRAIL,
          event_type: EventType.GUARDRAIL_DECISION,
          payload: {
            check: 'protocol_signature',
            outcome: 'BLOCK',
            detail: err.message
          }
        });
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const { cartMandate, paymentMandate } = internalMandates;
    const amountPaise = cartMandate.total_paise;
    const sessionId = `x402_${crypto.randomBytes(8).toString('hex')}`;

    // The payer's x402 proof is carried through and recorded, not verified here.
    // Its shape is enforced upstream in x402Adapter (unsigned or malformed
    // payloads never reach this line); its cryptography belongs to the x402 rail,
    // which settles it. The merchant server deliberately does not pretend to
    // verify it against a key of its own — doing so would either be theatre or,
    // worse, an authorization decision made by a server-held key. What gates the
    // money below is the human.
    sharedAuditLog.append({
      session_id: sessionId,
      actor: Actor.MERCHANT_SERVER,
      event_type: EventType.GUARDRAIL_DECISION,
      payload: {
        check: 'x402_protocol_proof',
        outcome: 'ALLOW',
        detail: 'JWS-shaped payer proof accepted from the x402 rail; not merchant-verifiable',
        source_protocol: 'x402',
        nonce: paymentMandate.nonce,
      },
    });

    const userRow = db.prepare('SELECT budget_cap_paise, delegation_mode FROM users WHERE principal_id = ?').get(principal_id);
    const delegationMode = userRow && userRow.delegation_mode ? userRow.delegation_mode : 'full';
    const capPaise = userRow && Number.isInteger(userRow.budget_cap_paise) ? userRow.budget_cap_paise : DEFAULT_CAP_PAISE;

    // Guardrail 1: ATOMIC Velocity Reserve (TOCTOU fix)
    let reservationId;
    try {
      reservationId = await reserveSpend(principal_id, amountPaise, capPaise, DEFAULT_VELOCITY_WINDOW_MS);
    } catch (err) {
      if (err instanceof VelocityExceededError || err.name === 'VelocityExceededError') {
        sharedAuditLog.append({
          session_id: sessionId,
          actor: Actor.GUARDRAIL,
          event_type: EventType.GUARDRAIL_DECISION,
          payload: {
            check: 'velocity_limit',
            outcome: 'BLOCK',
            detail: err.detail || err.message
          }
        });
        return res.status(403).json({ error: 'GUARDRAIL_VELOCITY_EXCEEDED' });
      }
      throw err;
    }

    // From here on, we MUST call commitSpend or releaseSpend.
    try {
      // Guardrail 2: Evaluate Delegation
      const delegationDecision = evaluateDelegation(delegationMode, amountPaise, capPaise);

      if (!delegationDecision.allowed) {
        // The human's authenticator is the only thing that can lift this. The
        // approval must be signed over this payment's nonce and amount, so an
        // approval obtained for a smaller charge or a different payment does not
        // transfer.
        const approval = await humanAuth.verifyApprovalMandate({
          approvalMandate: req.body.approval_mandate,
          principalId: principal_id,
          sessionId: approvalTransactionId(paymentMandate.nonce),
          cartMandateId: null,
          amountPaise,
        });

        if (!approval.verified) {
          releaseSpend(principal_id, reservationId);
          sharedAuditLog.append({
            session_id: sessionId,
            actor: Actor.GUARDRAIL,
            event_type: EventType.GUARDRAIL_DECISION,
            payload: {
              check: 'delegation_mode',
              outcome: 'BLOCK',
              detail: delegationDecision.reason,
              approval_reason: approval.reason,
            }
          });
          const code = delegationDecision.requiresApprovalMandate
            ? 'APPROVAL_MANDATE_REQUIRED'
            : 'DELEGATION_DENIED';
          const status = delegationDecision.requiresApprovalMandate ? 402 : 403;
          return res.status(status).json({
            error: code,
            message: `${delegationDecision.reason} (${approval.reason})`,
          });
        }

        sharedAuditLog.append({
          session_id: sessionId,
          actor: Actor.HUMAN,
          event_type: EventType.GUARDRAIL_DECISION,
          payload: {
            check: 'delegation_mode',
            outcome: 'ALLOW',
            detail: 'Human-signed ApprovalMandate authorized this x402 payment',
            authorized_by: 'approval-mandate',
            credential_id: approval.credentialId,
            amount_paise: amountPaise,
          }
        });
      }

      // Guardrail 3: Transition Session
      let session = { state: 'CREATED', sessionId };
      try {
        session = transitionSession(session, 'CONFIRMED');
      } catch (err) {
        releaseSpend(principal_id, reservationId);
        sharedAuditLog.append({
          session_id: sessionId,
          actor: Actor.GUARDRAIL,
          event_type: EventType.GUARDRAIL_DECISION,
          payload: {
            check: 'state_machine',
            outcome: 'BLOCK',
            detail: err.message
          }
        });
        return res.status(409).json({ error: err.message });
      }

      // Execute Razorpay Settlement Logic
      const receiptId = `receipt_x402_${crypto.randomBytes(4).toString('hex')}`;
      let rzpOrder;
      try {
        rzpOrder = await razorpayClient.createOrder({
          amount: amountPaise,
          currency: 'INR',
          receipt: receiptId,
          notes: { session_id: sessionId }
        });
      } catch (err) {
        releaseSpend(principal_id, reservationId);
        sharedAuditLog.append({
          session_id: sessionId,
          actor: Actor.MERCHANT_SERVER,
          event_type: EventType.FAILURE,
          payload: {
            code: 'PAYMENT_FAILED',
            message: err.message
          }
        });
        return res.status(502).json({ error: 'PAYMENT_FAILED', message: err.message });
      }

      // Commit Spend — payment succeeded, finalize the reservation
      commitSpend(principal_id, reservationId);

      // Audit Log: Success
      sharedAuditLog.append({
        session_id: sessionId,
        actor: Actor.MERCHANT_SERVER,
        event_type: EventType.STATE_TRANSITION,
        payload: {
          note: 'CHECKOUT_COMPLETED',
          source_protocol: 'x402',
          principal_id: principal_id,
          amount_paise: amountPaise,
          razorpay_order_id: rzpOrder.id
        }
      });

      return res.status(200).json({
        success: true,
        session_id: sessionId,
        state: session.state,
        razorpay_order_id: rzpOrder.id,
        cart_mandate: cartMandate,
        payment_mandate: paymentMandate
      });

    } catch (err) {
      // Safety net: release reservation on any unexpected error
      releaseSpend(principal_id, reservationId);
      throw err;
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
