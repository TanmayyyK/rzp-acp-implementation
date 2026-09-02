'use strict';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Validates that a value is a well-formed idempotency key: a string,
 * 8-128 characters, restricted to letters, digits, hyphens, and underscores.
 *
 * @param {*} key
 * @returns {boolean}
 */
function isValidIdempotencyKey(key) {
  return typeof key === 'string' && IDEMPOTENCY_KEY_PATTERN.test(key);
}

module.exports = {
  isValidIdempotencyKey,
};
