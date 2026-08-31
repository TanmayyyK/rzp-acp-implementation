'use strict';

/**
 * x402 -> AP2 translation layer.
 * -------------------------------------------------------------------------
 * Zero-dependency (native `crypto` only) normalizer that turns Coinbase x402
 * HTTP-402 handshake artifacts into the canonical mandate fields consumed by
 * the internal AP2 Mandate Engine (Agent Circle Trust Core).
 *
 * Pure data transformation: no Express routes, no DB, no network I/O, and no
 * merchant signing. The merchant-signed VC envelope (the "Shape-C" mandate
 * enforced by schemas/validate.js) is minted and EdDSA-signed downstream by
 * src/routes/checkout.js (buildCartMandate + signEdDSA). This module's sole
 * job is to normalize *untrusted* x402 input into deterministic integer-paise
 * structures and to fail loudly when that input is malformed or unsigned.
 */

const { randomUUID } = require('crypto');

const NETWORK = 'base';
const CURRENCY = 'INR';
const SOURCE_PROTOCOL = 'x402';
const CHALLENGE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Thrown when an x402 payment payload is missing required cryptographic fields
 * (signature / nonce). Mirrors the repo's error convention (extends Error with
 * a stable `name` + `code`), e.g. InvalidStateTransitionError, IdempotencyKeyError.
 */
class InvalidProtocolError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'InvalidProtocolError';
    this.code = 'X402_INVALID_PROTOCOL';
  }
}

/**
 * Assert that a value is a non-negative integer count of paise.
 *
 * Financial determinism: floats are rejected outright rather than rounded, so
 * no monetary amount is ever silently mutated (499.99 must never become 500).
 *
 * @param {unknown} value
 * @param {string} label - field name, for the error message
 * @returns {number} the validated integer paise value
 */
function assertIntegerPaise(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number of paise (received: ${String(value)})`);
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be integer paise; floating-point amount detected (${value})`);
  }
  if (value < 0) {
    throw new TypeError(`${label} must be non-negative paise (received: ${value})`);
  }
  return value;
}

/**
 * @typedef {Object} LineItem - canonical ACP line item (schemas/validate.js shape).
 * @property {string} sku
 * @property {string} title
 * @property {string} category
 * @property {number} quantity   - positive integer
 * @property {number} unit_price - non-negative integer paise
 */

/**
 * Normalize x402 line items into the canonical integer-paise line-item shape.
 * Absent items -> []. Per-item prices are held to the same determinism rule as
 * the cart total; a settlement line item without an integer paise price is
 * malformed and rejected.
 *
 * @param {Array<object>|undefined|null} items
 * @returns {LineItem[]}
 */
function normalizeLineItems(items) {
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) {
    throw new TypeError('x402PaymentPayload.items must be an array when present');
  }
  return items.map((item, i) => {
    if (item === null || typeof item !== 'object') {
      throw new TypeError(`items[${i}] must be an object`);
    }
    const unitPrice = assertIntegerPaise(
      item.unit_price ?? item.unit_price_paise ?? item.price,
      `items[${i}].unit_price`
    );
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new TypeError(`items[${i}].quantity must be a positive integer (received: ${String(quantity)})`);
    }
    return {
      sku: String(item.sku ?? item.id ?? `SKU-${i + 1}`),
      title: String(item.title ?? item.name ?? `Item ${i + 1}`),
      category: String(item.category ?? 'general'),
      quantity,
      unit_price: unitPrice,
    };
  });
}

/**
 * @typedef {Object} X402Challenge
 * @property {402} status
 * @property {{ 'x-402-payment-required': 'true' }} headers
 * @property {{ network: string, address: string, amount: string, currency: 'INR', nonce: string, expires_at: string }} payload
 */

/**
 * Construct the HTTP 402 challenge required by the x402 handshake.
 *
 * @param {number} cartAmount - amount in integer paise
 * @param {string} address    - merchant receiving / settlement address
 * @returns {X402Challenge}
 */
function generateChallenge(cartAmount, address) {
  const amount = assertIntegerPaise(cartAmount, 'cartAmount');
  if (typeof address !== 'string' || address.trim() === '') {
    throw new TypeError('address must be a non-empty string');
  }

  return {
    status: 402,
    headers: { 'x-402-payment-required': 'true' },
    payload: {
      network: NETWORK,
      address,
      // Validated as an integer above; serialized as a string on the wire so
      // JSON transport can never coerce it to a lossy float.
      amount: String(amount),
      currency: CURRENCY,
      nonce: randomUUID(),
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    },
  };
}

/**
 * @typedef {Object} InternalMandates
 * @property {{ principal_id: string, total_paise: number, line_items: LineItem[], source_protocol: 'x402' }} cartMandate
 * @property {{ proof: string, nonce: string, timestamp: number }} paymentMandate
 */

/**
 * Bridge a signed x402 payment payload to the internal CartMandate /
 * PaymentMandate fields. The merchant envelope + EdDSA signing happens
 * downstream; here we only normalize and carry the client's x402 proof through
 * faithfully (no fabricated signatures).
 *
 * @param {object} x402PaymentPayload - the signed receipt from the client
 * @param {string} principalId        - authenticated human session id (liable principal)
 * @returns {InternalMandates}
 * @throws {TypeError} on a non-object payload, missing principal, or a floating-point amount
 * @throws {InvalidProtocolError} when the required cryptographic fields (signature, nonce) are absent
 */
function translateToInternalMandate(x402PaymentPayload, principalId) {
  if (x402PaymentPayload === null || typeof x402PaymentPayload !== 'object' || Array.isArray(x402PaymentPayload)) {
    throw new TypeError('x402PaymentPayload must be an object');
  }
  if (typeof principalId !== 'string' || principalId.trim() === '') {
    throw new TypeError('principalId must be a non-empty string');
  }

  const { signature, nonce } = x402PaymentPayload;
  if (typeof signature !== 'string' || signature.trim() === '') {
    throw new InvalidProtocolError('x402 payload missing required cryptographic field: signature');
  }
  // Enforce JWS detached format: header..signature (e.g. "eyJhbGciOiJFZERTQSJ9..base64urlSig").
  // Rejecting arbitrary non-empty strings closes the forgery vector where any
  // junk string passed the old trim() check.
  if (!signature.includes('..') || signature.split('..').length !== 2 || signature.split('..')[1].trim() === '') {
    throw new InvalidProtocolError('x402 signature must be in JWS detached format (header..signature)');
  }
  if (typeof nonce !== 'string' || nonce.trim() === '') {
    throw new InvalidProtocolError('x402 payload missing required cryptographic field: nonce');
  }

  const totalPaise = assertIntegerPaise(x402PaymentPayload.amount, 'x402PaymentPayload.amount');

  return {
    cartMandate: {
      principal_id: principalId,
      total_paise: totalPaise,
      line_items: normalizeLineItems(x402PaymentPayload.items),
      source_protocol: SOURCE_PROTOCOL,
    },
    paymentMandate: {
      proof: signature,
      nonce,
      timestamp: Date.now(),
    },
  };
}

module.exports = {
  generateChallenge,
  translateToInternalMandate,
  InvalidProtocolError,
};
