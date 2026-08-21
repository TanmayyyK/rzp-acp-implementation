'use strict';

/**
 * Product feed route (ACP).
 *
 * GET /feed — returns the mock ACP product feed.
 *
 * Backed by the pure, immutable mockProductFeed module. This is the
 * catalog the checkout session endpoints price against: a line item's
 * `sku` matches a product `id` from this feed.
 */

const express = require('express');
const { getMockProductFeed } = require('../lib/mockProductFeed');

const router = express.Router();

// GET /feed
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
