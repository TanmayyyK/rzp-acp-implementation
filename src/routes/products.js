'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');

// The catalog stores the same price in two columns (`unit_price_paise` and the
// NOT NULL `price_paise`). Checkout prices from `unit_price_paise`
// (resolveLineItems in src/routes/checkout.js), so search MUST read the same
// expression — a filter that ranked on one column while checkout charged from
// the other is exactly the search-says-X/charge-says-Y divergence the
// zero-trust pricing firewall exists to rule out.
const PRICE_PAISE = 'COALESCE(unit_price_paise, price_paise)';

// Hard ceiling on rows returned to the buyer agent. The catalog is sized for
// 10,000+ SKUs; an unbounded feed would exhaust the LLM's context window long
// before it exhausted the table.
const SEARCH_LIMIT = 15;

// GET /api/v1/products
//
// Parameterized search. Every caller-supplied value is bound (`?`) — no value
// is ever concatenated into SQL — so the query shape is fixed at authoring time
// and only literals vary.
//
// The response is deliberately narrow: { sku, name, price_inr, stock }. The row
// carries risk_tier, max_quantity_per_order, item_type and description, and none
// of them cross this boundary. risk_tier and max_quantity_per_order are
// enforcement inputs the server reads for itself (src/middleware/guardrails.js);
// putting them in front of the agent would invite it to reason about limits it
// has no authority over, and cost tokens on every row to do it.
router.get('/', (req, res) => {
  const { category, max_price, query } = req.query;

  // `availability = 1` is part of the fixed shape, not a caller filter: an
  // out-of-stock SKU is one checkout will reject anyway (PRODUCT_UNAVAILABLE),
  // so surfacing it only spends context on a cart that cannot complete.
  let sql =
    `SELECT id AS sku, title AS name, ${PRICE_PAISE} AS price_paise, stock_count AS stock ` +
    'FROM products WHERE availability = 1';
  const params = [];

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }

  if (max_price) {
    const maxPaise = parseInt(max_price, 10);
    if (!isNaN(maxPaise)) {
      sql += ` AND ${PRICE_PAISE} <= ?`;
      params.push(maxPaise);
    }
  }

  if (query) {
    // Each word narrows the result set (AND), so a more specific query returns
    // strictly fewer rows — the behaviour the tool description asks the agent to
    // exploit when a search comes back too broad.
    const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    for (const word of words) {
      sql += ' AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?)';
      const likeQuery = `%${word}%`;
      params.push(likeQuery, likeQuery);
    }
  }

  // Cheapest-first, then id: without an ORDER BY, "the 15 rows" is whichever 15
  // the planner happens to reach, so the same query could answer differently
  // across runs. Ascending price also makes the truncated window the useful one
  // for a budget-bounded shopper.
  sql += ` ORDER BY ${PRICE_PAISE} ASC, id ASC LIMIT ${SEARCH_LIMIT}`;

  const results = db.prepare(sql).all(params).map((row) => ({
    sku: row.sku,
    name: row.name,
    price_inr: row.price_paise / 100,
    stock: row.stock,
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
