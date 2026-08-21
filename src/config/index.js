'use strict';

/**
 * Environment configuration.
 * Loads from .env via dotenv and exposes validated config for the app.
 * All money amounts referenced in config are in paise (ADR-004).
 */

const dotenv = require('dotenv');
dotenv.config();

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,

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
};

module.exports = config;
