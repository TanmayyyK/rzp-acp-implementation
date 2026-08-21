'use strict';

/**
 * Feed route — ACP product feed using the Sonnet-drafted mockProductFeed.
 *
 * GET /api/v1/feed  — returns the full ACP-shaped product feed
 *
 * This is the canonical machine-readable product catalog endpoint
 * for AI shopping agents, separate from the human-oriented /products route.
 */

const express = require('express');
const { getMockProductFeed } = require('../lib/mockProductFeed');

const router = express.Router();

// GET /api/v1/feed
router.get('/', (_req, res) => {
  const products = getMockProductFeed();

  res.json({
    version: '2.0',
    protocol: 'ACP',
    feed_type: 'product_catalog',
    currency: 'INR',
    products,
    count: products.length,
    generated_at: new Date().toISOString(),
  });
});

module.exports = router;
