'use strict';

/**
 * Environment configuration.
 * Loads from .env via dotenv and exposes validated config for the app.
 * All money amounts referenced in config are in paise (ADR-004).
 */

const dotenv = require('dotenv');
dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in production');
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  isProduction,
  sessionSecret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3001')
    .split(',').map((origin) => origin.trim()).filter(Boolean),

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },

  // Auto-approve threshold in paise (ADR-003).
  // Amounts above this require human approval via Payment Link.
  autoApproveThresholdPaise: parseInt(process.env.AUTO_APPROVE_THRESHOLD_PAISE, 10) || 1000000, // ₹10,000

  // Default currency
  currency: 'INR',

  // Identity the buyer agent asserts in its attestation header (ADR-008).
  // Shared so the agent and the grant-issuing route name the same agent
  // instead of each hardcoding a literal that could drift apart.
  agentId: process.env.AGENT_ID || 'buyer_agent_1',

  // How long a human's delegation grant stays valid before it must be re-signed.
  delegationGrantTtlMs: parseInt(process.env.DELEGATION_GRANT_TTL_MS, 10) || 30 * 60 * 1000,
};

module.exports = config;
