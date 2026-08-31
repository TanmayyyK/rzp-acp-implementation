'use strict';

const { randomUUID } = require('crypto');

/**
 * Idempotency wrapper for Razorpay API calls.
 *
 * This module never talks to Razorpay itself — you pass in the function
 * that actually performs the API call (`requestFn`), so the wrapper stays
 * standalone, dependency-free, and easy to unit test. It just handles:
 *
 *   1. Generating/validating idempotency keys.
 *   2. Caching the response of a successful call against its key.
 *   3. Returning the cached response (no network call) if the same key
 *      is submitted again.
 *   4. Deduplicating concurrent in-flight calls that share a key.
 *   5. Distinguishing network-drop errors (safe to retry — we don't know
 *      whether Razorpay actually processed the request) from other
 *      errors (e.g. validation failures, which will just fail again).
 *
 * The module has no shared global state: `createIdempotencyWrapper()` is
 * a factory that hands back a fresh, independent cache each time it's
 * called, which keeps it safe for tests and multiple concurrent callers.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // Razorpay's own guidance: keys are meaningful for 24h.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
]);

class IdempotencyKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdempotencyKeyError';
  }
}

class RazorpayRequestError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: Error, retryable: boolean }} opts
   */
  constructor(message, opts) {
    super(message);
    this.name = 'RazorpayRequestError';
    this.retryable = Boolean(opts && opts.retryable);
    if (opts && opts.cause) this.cause = opts.cause;
  }
}

/**
 * Generates a unique idempotency key.
 *
 * @param {string} [prefix='idem'] - Namespacing prefix, e.g. 'order' or 'payout'.
 * @returns {string} e.g. "idem_3f9a1c2e-...-uuid"
 */
function generateIdempotencyKey(prefix = 'idem') {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('prefix must be a non-empty string');
  }
  return `${prefix}_${randomUUID()}`;
}

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

/**
 * Best-effort check for whether an error represents a dropped connection
 * or timeout (as opposed to a deterministic rejection from Razorpay, like
 * a validation error). Network errors are treated as "we don't know if
 * the request landed" and are safe to retry with the same idempotency key.
 *
 * @param {*} err
 * @returns {boolean}
 */
function isNetworkError(err) {
  if (!err) return false;
  if (err.code && NETWORK_ERROR_CODES.has(err.code)) return true;
  if (err.name === 'AbortError') return true;
  if (typeof err.message === 'string' && /network|timeout|timed out/i.test(err.message)) return true;
  return false;
}

/**
 * Creates an independent idempotency-wrapped executor with its own
 * in-memory cache.
 *
 * @param {Object} [options]
 * @param {number} [options.ttlMs=86400000] - How long a cache entry stays valid.
 * @returns {{
 *   execute: (key: string, requestFn: () => Promise<*>, options?: { scope?: string }) => Promise<*>,
 *   getStatus: (key: string) => ('in_progress'|'success'|'failed'|undefined),
 *   clear: () => void,
 *   size: () => number,
 *   generateIdempotencyKey: typeof generateIdempotencyKey,
 *   isValidIdempotencyKey: typeof isValidIdempotencyKey,
 * }}
 */
function createIdempotencyWrapper(options = {}) {
  const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const cache = new Map();

  function readEntry(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Executes `requestFn` under the given idempotency key.
   *
   * - If a successful response is already cached for this key, it's
   *   returned immediately — Razorpay is never called again.
   * - If a call for this key is already in flight, the caller awaits
   *   that same in-flight promise instead of starting a duplicate call.
   * - On a network-drop error, the cache entry is cleared so a retry
   *   with the same key tries again (we can't know if Razorpay actually
   *   processed the original request).
   * - On any other error, the failure is recorded (for `getStatus`
   *   introspection) but the key is NOT permanently blocked — a caller
   *   is free to retry once they've fixed whatever caused the failure.
   *
   * @param {string} key - Idempotency key (see `isValidIdempotencyKey`).
   * @param {() => Promise<*>} requestFn - Performs the actual Razorpay call.
   * @param {Object} [options]
   * @param {string} [options.scope] - Namespace the cache entry under a
   *   server-controlled scope (e.g. a checkout session_id). A client-supplied
   *   idempotency key is only guaranteed unique WITHIN such a scope, so the
   *   same key replayed against a different scope must not return the first
   *   scope's cached response. Omit for a globally-keyed entry (legacy).
   * @returns {Promise<*>} The (possibly cached) response.
   */
  async function execute(key, requestFn, options = {}) {
    if (!isValidIdempotencyKey(key)) {
      throw new IdempotencyKeyError(`Invalid idempotency key: ${JSON.stringify(key)}`);
    }
    if (typeof requestFn !== 'function') {
      throw new TypeError('requestFn must be a function that returns a Promise');
    }

    // A client-supplied idempotency key is only unique within its caller scope
    // (e.g. one checkout session). Namespacing the cache key by the
    // server-controlled scope stops a key replayed across sessions from
    // returning another session's cached Razorpay order. The raw `key` is what
    // gets validated above; `scope` is trusted (never client-derived).
    const scope = typeof options.scope === 'string' && options.scope.length > 0 ? options.scope : '';
    const cacheKey = scope ? `${scope}::${key}` : key;

    const existing = readEntry(cacheKey);

    if (existing) {
      if (existing.status === 'success') {
        return existing.response;
      }
      if (existing.status === 'in_progress') {
        return existing.promise;
      }
      // status === 'failed': fall through and attempt a fresh call.
    }

    const startedAt = existing ? existing.createdAt : Date.now();

    const promise = (async () => {
      try {
        const response = await requestFn();
        cache.set(cacheKey, {
          status: 'success',
          response,
          createdAt: startedAt,
          updatedAt: Date.now(),
          expiresAt: Date.now() + ttlMs,
        });
        return response;
      } catch (err) {
        const retryable = isNetworkError(err);

        if (retryable) {
          // Unknown outcome on Razorpay's side — don't leave a stale
          // "in_progress" entry blocking a legitimate retry.
          cache.delete(cacheKey);
        } else {
          cache.set(cacheKey, {
            status: 'failed',
            error: { name: err && err.name, message: err && err.message },
            createdAt: startedAt,
            updatedAt: Date.now(),
            expiresAt: Date.now() + ttlMs,
          });
        }

        throw new RazorpayRequestError(
          (err && err.message) || 'Razorpay request failed',
          { cause: err, retryable }
        );
      }
    })();

    // Recorded synchronously (before this function yields) so a
    // concurrent call with the same key can find and await it.
    cache.set(cacheKey, {
      status: 'in_progress',
      promise,
      createdAt: startedAt,
      updatedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    });

    return promise;
  }

  function getStatus(key) {
    const entry = readEntry(key);
    return entry ? entry.status : undefined;
  }

  function clear() {
    cache.clear();
  }

  function size() {
    return cache.size;
  }

  return Object.freeze({
    execute,
    getStatus,
    clear,
    size,
    generateIdempotencyKey,
    isValidIdempotencyKey,
  });
}

module.exports = {
  createIdempotencyWrapper,
  generateIdempotencyKey,
  isValidIdempotencyKey,
  isNetworkError,
  IdempotencyKeyError,
  RazorpayRequestError,
  DEFAULT_TTL_MS,
};
