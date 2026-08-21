const crypto = require('crypto');

/**
 * Verifies a Razorpay webhook signature.
 *
 * Razorpay signs the raw (unparsed) request body with HMAC-SHA256 using
 * your webhook secret, and sends the resulting hex digest in the
 * `x-razorpay-signature` header. This function recomputes that digest
 * and compares it against the received signature using a constant-time
 * comparison to avoid timing attacks.
 *
 * @param {string|Buffer} rawBody - The raw, unparsed request body exactly
 *   as received (do not JSON.parse/stringify it first — re-serializing
 *   can change byte-for-byte content and break verification).
 * @param {string} signature - The value of the `x-razorpay-signature` header.
 * @param {string} secret - Your Razorpay webhook secret.
 * @returns {boolean} true if the signature is valid, false otherwise.
 */
function verifyRazorpaySignature(rawBody, signature, secret) {
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
    throw new TypeError('rawBody must be a string or Buffer');
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    throw new TypeError('signature must be a non-empty string');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('secret must be a non-empty string');
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const receivedBuffer = Buffer.from(signature, 'utf8');

  // Lengths must match before calling timingSafeEqual, which throws
  // on mismatched buffer lengths rather than returning false.
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

module.exports = { verifyRazorpaySignature };
