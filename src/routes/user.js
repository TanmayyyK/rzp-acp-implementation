'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// POST /user/budget
// Protected by the human WebAuthn session cookie
router.post('/budget', (req, res) => {
  if (!req.session || !req.session.authenticated || !req.session.principal_id) {
    return res.status(401).json({ error: 'Unauthorized: Valid WebAuthn session required' });
  }

  const { budget_cap_paise } = req.body;
  if (typeof budget_cap_paise !== 'number' || budget_cap_paise < 0) {
    return res.status(400).json({ error: 'Invalid budget_cap_paise' });
  }

  const principal_id = req.session.principal_id;

  try {
    db.prepare(`
      INSERT INTO users (principal_id, budget_cap_paise)
      VALUES (?, ?)
      ON CONFLICT(principal_id) DO UPDATE SET budget_cap_paise=excluded.budget_cap_paise
    `).run(principal_id, budget_cap_paise);

    res.json({ success: true, principal_id, budget_cap_paise });
  } catch (err) {
    console.error('Update budget error:', err);
    res.status(500).json({ error: 'Failed to update budget' });
  }
});

module.exports = router;
