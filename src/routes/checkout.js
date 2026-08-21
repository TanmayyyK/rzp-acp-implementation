'use strict';

/**
 * Checkout session placeholder routes (ACP 5-stage lifecycle).
 * Full implementation arrives on Day 3–4; this wires the route
 * shapes and validates the idempotency-key requirement now.
 */

const express = require('express');
const router = express.Router();

// POST /api/v1/checkout/sessions — create session (ACP stage 1)
router.post('/sessions', (req, res) => {
  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Checkout session creation — arriving Day 3',
      retriable: false,
    },
  });
});

// PATCH /api/v1/checkout/sessions/:id — update session (ACP stage 2)
router.patch('/sessions/:id', (req, res) => {
  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Checkout session update — arriving Day 3',
      retriable: false,
    },
  });
});

// GET /api/v1/checkout/sessions/:id — get session state (ACP stage 3)
router.get('/sessions/:id', (req, res) => {
  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Checkout session state — arriving Day 3',
      retriable: false,
    },
  });
});

// POST /api/v1/checkout/sessions/:id/complete — complete checkout (ACP stage 4)
router.post('/sessions/:id/complete', (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) {
    return res.status(400).json({
      error: {
        code: 'IDEMPOTENCY_KEY_MISSING',
        message: 'Idempotency-Key header is required on state-mutating checkout calls (ADR-007)',
        retriable: false,
      },
    });
  }

  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Checkout completion — arriving Day 4',
      retriable: false,
    },
  });
});

// POST /api/v1/checkout/sessions/:id/cancel — cancel session (ACP stage 5)
router.post('/sessions/:id/cancel', (req, res) => {
  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Checkout cancellation — arriving Day 3',
      retriable: false,
    },
  });
});

module.exports = router;
