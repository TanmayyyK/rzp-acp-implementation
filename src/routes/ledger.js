'use strict';

const express = require('express');
const { auditEmitter } = require('../lib/auditLog');
const router = express.Router();

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Handle client disconnect
  const onNewBlock = (block) => {
    // Redact payload same as GET /audit-log if not admin, but for simplicity here we just send it.
    // In actual implementation, we might want to check admin auth, but SSE is often 1-way.
    // Wait, let's redact if no admin token, just like GET /audit-log.
    const isAdmin = req.headers['authorization'] === `Bearer ${process.env.ADMIN_SECRET || 'admin_secret'}`;
    let payload = block.payload || {};
    
    if (!isAdmin) {
      const payloadStr = JSON.stringify(payload);
      const redactedStr = payloadStr.replace(/"(session_id|intent_mandate_id|credential_id|mandate_id|order_id|razorpay_order_id|receipt|payment_id|payment_link_id|agent_id|principal_id)":"[^"]+"/g, '"$1":"[REDACTED]"');
      payload = JSON.parse(redactedStr);
    }
    
    const redactedBlock = { ...block, payload };
    res.write(`data: ${JSON.stringify(redactedBlock)}\n\n`);
  };

  auditEmitter.on('new_block', onNewBlock);

  req.on('close', () => {
    auditEmitter.off('new_block', onNewBlock);
  });
});

const db = require('../db');

router.get('/velocity', (req, res) => {
  try {
    const VELOCITY_WINDOW_MS = parseInt(process.env.GUARDRAIL_VELOCITY_WINDOW_MS || '3600000', 10);
    const cutoff = Date.now() - VELOCITY_WINDOW_MS;
    
    // In a multi-user app we'd filter by principalId, but for this demo UI we can just sum the ledger
    // or we can just pick the first principal.
    const row = db.prepare('SELECT SUM(amount_paise) as total_spend FROM velocity_ledger WHERE timestamp_ms > ?').get(cutoff);
    
    const rollingSpendPaise = row && row.total_spend ? row.total_spend : 0;
    
    res.json({ rollingSpend: rollingSpendPaise / 100 }); // Return in Rupees
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch velocity' });
  }
});

module.exports = router;
