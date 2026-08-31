'use strict';

/**
 * Razorpay client wrapper.
 *
 * Initializes the official SDK and exposes helpers for:
 *   - Order creation (POST /v1/orders)
 *   - Payment Link creation (POST /v1/payment_links)
 *
 * Read operations may retry. Payment-creating writes deliberately do not:
 * after a timeout the provider may have created the artifact, and blindly
 * retrying a non-idempotent PSP write risks a duplicate charge. The checkout
 * service persists an intent and reconciles by stable receipt first.
 */

const Razorpay = require('razorpay');
const config = require('../config');

// ---------------------------------------------------------------------------
// SDK instance
// ---------------------------------------------------------------------------
let instance = null;

function getInstance() {
  if (!instance) {
    if (!config.razorpay.keyId || !config.razorpay.keySecret) {
      throw new Error(
        'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env'
      );
    }
    instance = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
  }
  return instance;
}

class RazorpayRequestError extends Error {
  constructor(message, retryable, originalError) {
    super(message);
    this.name = 'RazorpayRequestError';
    this.retryable = retryable;
    this.originalError = originalError;
  }
}

// ---------------------------------------------------------------------------
// Exponential backoff wrapper (ADR-007)
// ---------------------------------------------------------------------------
async function withRetry(fn, { maxRetries = 3, baseDelayMs = 500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const statusCode = err.statusCode || err.status || 0;
      const retryable = statusCode === 429 || statusCode >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (!retryable || attempt === maxRetries) {
        throw new RazorpayRequestError(
          err.message || 'Razorpay request failed',
          retryable,
          err
        );
      }

      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new RazorpayRequestError(lastError.message, true, lastError);
}

// ---------------------------------------------------------------------------
// createOrder — POST /v1/orders  (1:1 with our ord_ + mandate chain)
// ---------------------------------------------------------------------------

/**
 * Create a Razorpay Order.
 *
 * @param {object} params
 * @param {number} params.amount        Amount in paise (integer, ADR-004).
 * @param {string} params.currency      ISO currency code (default INR).
 * @param {string} params.receipt       Our internal order id (ord_xxx).
 * @param {object} [params.notes]       Free-form key-value (max 15).
 * @returns {Promise<object>} Razorpay order entity.
 */
async function createOrder({ amount, currency = 'INR', receipt, notes = {} }) {
  const rz = getInstance();

  const orderParams = {
    amount,
    currency,
    receipt,
    notes,
    payment_capture: 1, // auto-capture
  };

  // Note: The Razorpay Node SDK does not natively support injecting
  // X-Idempotency-Key headers per-request. Therefore, idempotency
  // must be fully managed at the merchant database layer.
  return rz.orders.create(orderParams);
}

// ---------------------------------------------------------------------------
// createPaymentLink — POST /v1/payment_links  (human-in-the-loop, ADR-003)
// ---------------------------------------------------------------------------

/**
 * Create a Razorpay Payment Link for human approval flows.
 *
 * @param {object} params
 * @param {number} params.amount        Amount in paise.
 * @param {string} params.currency      ISO currency code.
 * @param {string} params.description   Short description shown to the payer.
 * @param {string} params.receipt       Our internal order id.
 * @param {string} params.callbackUrl   URL Razorpay redirects to after payment.
 * @param {object} [params.notes]       Free-form key-value.
 * @returns {Promise<object>} Razorpay payment link entity.
 */
async function createPaymentLink({ amount, currency = 'INR', description, receipt, callbackUrl, notes = {} }) {
  const rz = getInstance();

  const linkParams = {
    amount,
    currency,
    description,
    receipt,
    callback_url: callbackUrl || '',
    callback_method: callbackUrl ? 'get' : undefined,
    notes,
  };

  return rz.paymentLink.create(linkParams);
}

// ---------------------------------------------------------------------------
// fetchOrder — GET /v1/orders/{id}  (used by webhook handler & state checks)
// ---------------------------------------------------------------------------

/**
 * Fetch a Razorpay order by its Razorpay order_id.
 *
 * @param {string} razorpayOrderId  e.g. "order_PZxYwVuTsRqPoN"
 * @returns {Promise<object>}
 */
async function fetchOrder(razorpayOrderId) {
  const rz = getInstance();
  return withRetry(() => rz.orders.fetch(razorpayOrderId));
}

/** Find the provider order created for our stable merchant receipt. */
async function findOrderByReceipt(receipt) {
  const rz = getInstance();
  const result = await withRetry(() => rz.orders.all({ receipt, count: 10 }));
  const items = Array.isArray(result) ? result : (result.items || []);
  return items.find((item) => item.receipt === receipt) || null;
}

// ---------------------------------------------------------------------------
// cancelPaymentLink — POST /v1/payment_links/{id}/cancel
// ---------------------------------------------------------------------------

/**
 * Cancel a Razorpay Payment Link that has not yet been paid.
 *
 * @param {string} paymentLinkId
 * @returns {Promise<object>}
 */
async function cancelPaymentLink(paymentLinkId) {
  const rz = getInstance();
  return withRetry(() => rz.paymentLink.cancel(paymentLinkId));
}

module.exports = {
  getInstance,
  createOrder,
  createPaymentLink,
  fetchOrder,
  findOrderByReceipt,
  cancelPaymentLink,
  RazorpayRequestError,
  // Exported for testing
  _withRetry: withRetry,
};
