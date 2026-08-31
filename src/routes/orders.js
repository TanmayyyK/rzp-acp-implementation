'use strict';

/**
 * Retired direct Razorpay ingress.
 *
 * There is exactly one authority boundary for a Razorpay write:
 * POST /api/v1/checkout/sessions/:id/complete. It resolves catalog prices,
 * validates a live human grant / approval, reserves velocity, persists an
 * intent, and uses a stable receipt before invoking Razorpay. Keeping a
 * convenient second REST route would make those controls optional.
 */

const express = require('express');

const router = express.Router();

function retired(_req, res) {
  return res.status(410).json({
    error: {
      code: 'DIRECT_RAZORPAY_INGRESS_RETIRED',
      message: 'Direct order and payment-link creation is retired. Create an authorized checkout session and complete it instead.',
      retriable: false,
    },
  });
}

router.post('/', retired);
router.post('/link', retired);
router.get('/:id', retired);

module.exports = router;
