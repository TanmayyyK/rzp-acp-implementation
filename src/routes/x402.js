'use strict';

/**
 * x402 compatibility surface.
 *
 * The former /submit endpoint was a second Razorpay writer with an independent
 * state machine. It is retired until x402 can create a catalog-backed checkout
 * session and use the same durable authorization/payment service as ACP.
 */

const express = require('express');
const { generateChallenge } = require('../adapters/x402Adapter');

const router = express.Router();

router.get('/checkout', (req, res) => {
  const cartAmount = parseInt(req.query.cartAmount, 10);
  if (!Number.isInteger(cartAmount) || cartAmount <= 0) {
    return res.status(400).json({ error: 'cartAmount must be a positive integer (paise)' });
  }
  return res.status(402).json(generateChallenge(cartAmount, req.query.address || '0xMerchantSettlementAddress123'));
});

router.get('/approve/challenge', (_req, res) => res.status(410).json({
  error: 'X402_MONEY_INGRESS_RETIRED',
  message: 'x402 approvals are unavailable until they are routed through the guarded checkout service.',
}));

router.post('/submit', (_req, res) => res.status(410).json({
  error: 'X402_MONEY_INGRESS_RETIRED',
  message: 'x402 settlement is retired. All payment creation must use an authorized checkout session.',
}));

module.exports = router;
