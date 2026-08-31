'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/v1/products
router.get('/', (req, res) => {
  const { category, max_price, query } = req.query;
  
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  
  if (max_price) {
    const maxPaise = parseInt(max_price, 10);
    if (!isNaN(maxPaise)) {
      sql += ' AND price_paise <= ?';
      params.push(maxPaise);
    }
  }
  
  if (query) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    for (const word of words) {
      sql += ' AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?)';
      const likeQuery = `%${word}%`;
      params.push(likeQuery, likeQuery);
    }
  }
  
  sql += ' LIMIT 15';
  const results = db.prepare(sql).all(params).map(row => ({
    id: row.id,
    sku: row.id, // Backwards compatibility
    title: row.title,
    description: row.description,
    price: row.price_paise,
    currency: row.currency,
    availability: row.availability === 1,
    category: row.category,
    images: row.image_url ? [row.image_url] : [],
    eligibility: { agent_purchasable: true },
  }));

  res.json({ products: results, count: results.length });
});

// GET /api/v1/products/:id
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({
      error: {
        code: 'PRODUCT_NOT_FOUND',
        message: `No product with ID ${req.params.id}`,
        retriable: false,
      },
    });
  }
  
  res.json({
    id: row.id,
    sku: row.id,
    title: row.title,
    description: row.description,
    price: row.price_paise,
    currency: row.currency,
    availability: row.availability === 1,
    category: row.category,
    images: row.image_url ? [row.image_url] : [],
    eligibility: { agent_purchasable: true },
  });
});

module.exports = router;
