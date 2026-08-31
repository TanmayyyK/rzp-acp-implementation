'use strict';

/**
 * jcs-hmac.js
 * ---------------------------------------------------------------------------
 * Standalone, dependency-free utility for:
 *
 *   1. Canonicalizing a JSON-compatible JavaScript value according to
 *      RFC 8785 - JSON Canonicalization Scheme (JCS).
 *   2. Signing the canonical form with HMAC-SHA256.
 *   3. Verifying a signature against a payload using a constant-time
 *      comparison.
 *
 * Only Node.js built-ins are used (the `crypto` module) - no third-party
 * dependencies.
 *
 * ---------------------------------------------------------------------------
 * JCS RULES IMPLEMENTED (RFC 8785)
 * ---------------------------------------------------------------------------
 *   - Object members are sorted by their key, compared as UTF-16 code
 *     unit sequences (i.e. plain lexicographic ordering of JS strings).
 *   - No insignificant whitespace anywhere in the output.
 *   - Numbers are serialized using the ECMAScript Number::toString
 *     algorithm (which is exactly what V8 already does for
 *     `String(number)` / template literals), with -0 normalized to "0".
 *     NaN and +/-Infinity are rejected, since they have no JSON
 *     representation.
 *   - Strings are escaped using the same minimal rules as
 *     JSON.stringify: '"', '\\', and control characters (U+0000-U+001F)
 *     are escaped; everything else (including non-ASCII characters) is
 *     left as literal UTF-8/UTF-16 text.
 *   - Arrays preserve element order; each element is canonicalized
 *     recursively.
 *   - `undefined` values, functions, and symbols are dropped from
 *     objects and rendered as `null` inside arrays, mirroring the
 *     behavior of JSON.stringify.
 *
 * KNOWN LIMITATIONS (inherent to representing JSON with native JS types)
 *   - JS numbers are IEEE-754 doubles, so integers outside
 *     Number.isSafeInteger() range, or decimal values requiring more
 *     precision than a double can hold, may already have lost precision
 *     before this module ever sees them. This module does not attempt
 *     to work around that; if you need exact big-integer or arbitrary-
 *     precision handling, represent those values as strings before
 *     canonicalizing.
 *   - Lone (unpaired) UTF-16 surrogates in strings are passed through
 *     unchanged, matching JSON.stringify's behavior, and are not
 *     specially repaired or rejected.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');

const HMAC_ALGORITHM = 'sha256';
const DEFAULT_ENCODING = 'hex';

/* ---------------------------------------------------------------------- *
 * Canonicalization (RFC 8785 - JCS)
 * ---------------------------------------------------------------------- */

/**
 * Canonicalizes a JSON-compatible JavaScript value into a JCS
 * (RFC 8785) compliant JSON string.
 *
 * @param {*} value - Any JSON-serializable value: object, array, string,
 *   number, boolean, or null. Values with a `toJSON()` method (e.g.
 *   `Date`) are converted first, exactly as `JSON.stringify` would.
 * @returns {string} The canonical JSON string representation of `value`.
 * @throws {TypeError} If `value` (or something nested inside it) cannot
 *   be represented as JSON (e.g. NaN, Infinity, or a non-plain object
 *   without a `toJSON` method).
 */
function canonicalize(value) {
  return serializeValue(value);
}

function serializeValue(value) {
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'boolean') return value ? 'true' : 'false';

  if (type === 'number') return serializeNumber(value);

  if (type === 'string') return serializeString(value);

  if (type === 'bigint') {
    throw new TypeError('Cannot canonicalize a BigInt: JSON has no BigInt representation. Convert it to a string or number first.');
  }

  if (Array.isArray(value)) return serializeArray(value);

  if (type === 'object') {
    if (typeof value.toJSON === 'function') {
      return serializeValue(value.toJSON());
    }
    if (!isPlainObject(value)) {
      throw new TypeError('Cannot canonicalize a non-plain object (e.g. Map, Set, class instance) without a toJSON() method.');
    }
    return serializeObject(value);
  }

  // undefined, function, symbol at the top level
  throw new TypeError(`Cannot canonicalize a value of type "${type}"`);
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeNumber(num) {
  if (!Number.isFinite(num)) {
    throw new TypeError('Cannot canonicalize a non-finite number (NaN or +/-Infinity); JSON has no representation for it.');
  }
  // ECMAScript's Number::toString already renders -0 as "0", and V8's
  // String(num) already implements the exact algorithm JCS mandates,
  // so no further special-casing of magnitude/exponent formatting is
  // needed here.
  return Object.is(num, -0) ? '0' : String(num);
}

function serializeString(str) {
  // JSON.stringify implements the same minimal escaping rules JCS
  // requires for strings: '"', '\\', and U+0000-U+001F are escaped
  // (using the shortest valid form); every other character, including
  // non-ASCII text, is emitted literally.
  return JSON.stringify(str);
}

function serializeArray(arr) {
  const items = arr.map((item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      // JSON.stringify renders these as `null` inside arrays.
      return 'null';
    }
    return serializeValue(item);
  });
  return `[${items.join(',')}]`;
}

function serializeObject(obj) {
  // RFC 8785 section 3.2.3: object members MUST be sorted by comparing
  // their names as sequences of UTF-16 code units. Array.prototype.sort()
  // with no comparator does exactly this for an array of strings.
  const keys = Object.keys(obj).sort();

  const members = [];
  for (const key of keys) {
    const val = obj[key];
    // JSON.stringify silently drops object properties whose value is
    // undefined, a function, or a symbol; JCS follows the same rule.
    if (val === undefined || typeof val === 'function' || typeof val === 'symbol') {
      continue;
    }
    members.push(`${serializeString(key)}:${serializeValue(val)}`);
  }
  return `{${members.join(',')}}`;
}

/* ---------------------------------------------------------------------- *
 * HMAC-SHA256 signing / verification
 * ---------------------------------------------------------------------- */

/**
 * Canonicalizes `payload` (via JCS) and signs it with HMAC-SHA256.
 *
 * @param {*} payload - JSON-serializable value to sign.
 * @param {string|Buffer|NodeJS.TypedArray|DataView} secret - HMAC secret key.
 * @param {Object} [options]
 * @param {'hex'|'base64'|'base64url'} [options.encoding='hex'] - Output
 *   encoding for the returned signature.
 * @returns {{ canonical: string, signature: string, algorithm: string }}
 *   `canonical` is the exact JCS string that was signed (useful for
 *   transmitting alongside the signature, or for debugging), `signature`
 *   is the HMAC digest in the requested encoding, and `algorithm` names
 *   the scheme used.
 */
function sign(payload, secret, options = {}) {
  assertValidSecret(secret);
  const encoding = options.encoding || DEFAULT_ENCODING;

  const canonical = canonicalize(payload);
  const signature = crypto
    .createHmac(HMAC_ALGORITHM, secret)
    .update(canonical, 'utf8')
    .digest(encoding);

  return { canonical, signature, algorithm: `HMAC-${HMAC_ALGORITHM.toUpperCase()}` };
}

/**
 * Verifies that `signature` is a valid HMAC-SHA256 signature of the JCS
 * canonicalization of `payload`, using a constant-time comparison to
 * avoid timing side-channels.
 *
 * @param {*} payload - JSON-serializable value that was (allegedly) signed.
 * @param {string} signature - Signature to check, in `options.encoding`.
 * @param {string|Buffer|NodeJS.TypedArray|DataView} secret - HMAC secret key.
 * @param {Object} [options]
 * @param {'hex'|'base64'|'base64url'} [options.encoding='hex'] - Encoding
 *   that `signature` is in. Must match what was used when signing.
 * @returns {boolean} `true` if the signature is valid, `false` otherwise
 *   (including on malformed input) - this function never throws for
 *   invalid signatures, only for a missing/invalid secret.
 */
function verify(payload, signature, secret, options = {}) {
  assertValidSecret(secret);

  if (typeof signature !== 'string' || signature.length === 0) {
    return false;
  }
  const encoding = options.encoding || DEFAULT_ENCODING;

  let expected;
  let actual;
  try {
    const canonical = canonicalize(payload);
    expected = crypto.createHmac(HMAC_ALGORITHM, secret).update(canonical, 'utf8').digest();
    actual = Buffer.from(signature, encoding);
  } catch (err) {
    // Malformed payload or malformed signature encoding -> not valid.
    return false;
  }

  // Guard against Buffer.from silently truncating malformed input
  // (e.g. odd-length hex): a length mismatch is simply an invalid
  // signature, and timingSafeEqual requires equal-length buffers.
  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Convenience helper that produces a self-contained, transmittable
 * envelope: `{ payload, signature, algorithm }`. The raw (non-canonical)
 * payload is preserved so the recipient can use it directly after
 * verification.
 *
 * @param {*} payload
 * @param {string|Buffer} secret
 * @param {Object} [options] - Same options as `sign`.
 * @returns {{ payload: *, signature: string, algorithm: string }}
 */
function createSignedEnvelope(payload, secret, options = {}) {
  const { signature, algorithm } = sign(payload, secret, options);
  return { payload, signature, algorithm };
}

/**
 * Verifies an envelope produced by `createSignedEnvelope`.
 *
 * @param {{ payload: *, signature: string }} envelope
 * @param {string|Buffer} secret
 * @param {Object} [options] - Same options as `verify`.
 * @returns {boolean}
 */
function verifySignedEnvelope(envelope, secret, options = {}) {
  if (!envelope || typeof envelope !== 'object') return false;
  return verify(envelope.payload, envelope.signature, secret, options);
}

function assertValidSecret(secret) {
  const isString = typeof secret === 'string';
  const isBufferLike = Buffer.isBuffer(secret) || ArrayBuffer.isView(secret);
  if ((!isString && !isBufferLike) || (isString && secret.length === 0)) {
    throw new TypeError('A non-empty secret key (string or Buffer) is required.');
  }
}

module.exports = {
  canonicalize,
  sign,
  verify,
  createSignedEnvelope,
  verifySignedEnvelope,
};
