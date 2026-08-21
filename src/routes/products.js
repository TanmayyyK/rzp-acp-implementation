'use strict';

/**
 * Products route — ACP product feed.
 *
 * GET /api/v1/products       — list all products
 * GET /api/v1/products/:sku  — single product by SKU
 *
 * Backed by a hardcoded catalog for Day 2. Will swap for DB on Day 3.
 */

const express = require('express');
const router = express.Router();

// Hardcoded catalog — amounts in paise (ADR-004)
const CATALOG = [
  {
    sku: 'SKU-AUDIO-001',
    title: 'Acme NC-700 Headphones',
    description: 'Over-ear noise-cancelling wireless headphones with 30hr battery.',
    price: 749900,
    currency: 'INR',
    availability: 'in_stock',
    category: 'audio',
    images: ['https://example.com/img/nc700-1.jpg'],
    eligibility: { agent_purchasable: true },
  },
  {
    sku: 'SKU-AUDIO-002',
    title: 'Acme Buds Pro',
    description: 'True wireless earbuds with active noise cancellation.',
    price: 249900,
    currency: 'INR',
    availability: 'in_stock',
    category: 'audio',
    images: ['https://example.com/img/buds-pro-1.jpg'],
    eligibility: { agent_purchasable: true },
  },
  {
    sku: 'SKU-ELEC-001',
    title: 'Acme SmartWatch X',
    description: 'Fitness smartwatch with GPS, heart rate monitor, 7-day battery.',
    price: 1499900,
    currency: 'INR',
    availability: 'in_stock',
    category: 'electronics',
    images: ['https://example.com/img/smartwatch-x-1.jpg'],
    eligibility: { agent_purchasable: true },
  },
  {
    sku: 'SKU-ELEC-002',
    title: 'Acme USB-C Hub',
    description: '7-in-1 USB-C hub with HDMI, USB-A, SD card reader.',
    price: 349900,
    currency: 'INR',
    availability: 'in_stock',
    category: 'electronics',
    images: ['https://example.com/img/usbc-hub-1.jpg'],
    eligibility: { agent_purchasable: true },
  },
];

// GET /api/v1/products
router.get('/', (req, res) => {
  const { category, max_price, query } = req.query;
  let results = CATALOG;

  if (category) {
    results = results.filter((p) => p.category === category);
  }
  if (max_price) {
    const maxPaise = parseInt(max_price, 10);
    if (!isNaN(maxPaise)) {
      results = results.filter((p) => p.price <= maxPaise);
    }
  }
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)
    );
  }

  res.json({ products: results, count: results.length });
});

// GET /api/v1/products/:sku
router.get('/:sku', (req, res) => {
  const product = CATALOG.find((p) => p.sku === req.params.sku);
  if (!product) {
    return res.status(404).json({
      error: {
        code: 'PRODUCT_NOT_FOUND',
        message: `No product with SKU ${req.params.sku}`,
        retriable: false,
      },
    });
  }
  res.json(product);
});

// Exported for testing
router._CATALOG = CATALOG;

module.exports = router;
