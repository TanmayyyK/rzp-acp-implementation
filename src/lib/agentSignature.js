'use strict';

/**
 * Agent request signature (X-Agorio-Signature) — Ed25519 asymmetric identity.
 *
 * This retires the old symmetric `AGENT_SECRET` HMAC. Under that scheme the
 * server held the same secret the agent signed with, so a server compromise (or
 * anyone who read the secret) could forge agent requests. The agent's identity
 * is now a true keypair: the agent holds AGENT_PRIVATE_KEY and signs; the server
 * holds only AGENT_PUBLIC_KEY and verifies. The server can no longer mint agent
 * signatures, which is the whole point of "asymmetric identity".
 *
 * What is signed is unchanged from the HMAC scheme — the full request binding:
 *   method, path, agent_id, principal_id, timestamp, nonce, and a hash of the
 *   body. Dropping any of these would make a captured signature replayable on a
 *   different verb, path, principal, or body, so the set is defined here ONCE and
 *   both the signer (agent) and verifier (server) build it identically. Keeping
 *   these three call sites (server verify, MCP client sign, test mock) in lockstep
 *   is exactly why this lives in one module rather than being copied inline.
 *
 * The wire format of the header is preserved: `t=<ms>,nonce=<hex>,sig=<value>`.
 * Only `sig` changes shape — it was a hex HMAC, it is now an Ed25519 detached
 * JWS (see src/lib/jcs-eddsa.js) over the JCS-canonicalized payload.
 */

const crypto = require('crypto');
const { signEdDSA, verifyEdDSA, generateEd25519KeyPair } = require('./jcs-eddsa');

// Signatures older than this are refused regardless of validity. This is the
// only anti-replay bound at the auth layer (there is no server-side nonce store
// here), so it is a security invariant, not a tuning knob — preserved from the
// HMAC scheme unchanged.
const SIGNATURE_TTL_MS = 5 * 60 * 1000;

/**
 * The exact set of request-binding fields the agent signs. Server and agent MUST
 * produce this identically or every signature fails, so there is one definition.
 * JCS (inside signEdDSA/verifyEdDSA) sorts keys, so field order here is irrelevant.
 */
function buildSignedPayload({ method, path, agentId, principalId, t, nonce, bodyHash }) {
  return {
    method,
    path,
    agent_id: agentId,
    principal_id: principalId,
    t: String(t),
    nonce,
    body_hash: bodyHash,
  };
}

/**
 * Canonical body hash. GET/HEAD carry no body; everything else hashes the JSON
 * serialization of the body (an absent body serializes as `{}`, matching what
 * express hands the server after parsing an empty POST). The verifier's rule is
 * authoritative and the signer mirrors it — hence one shared function.
 */
function canonicalBodyHash(method, body) {
  const bodyStr = method === 'GET' || method === 'HEAD' ? '' : JSON.stringify(body || {});
  return crypto.createHash('sha256').update(bodyStr).digest('hex');
}

/**
 * Zero-config keypair provisioning for dev and in-process test runs.
 *
 * Production configures the agent identity out of band: the agent process holds
 * AGENT_PRIVATE_KEY, the server holds AGENT_PUBLIC_KEY, and neither generates
 * anything. But there is no key server here — for local dev and the test suite we
 * mint an ephemeral pair, exactly as server.js mints the merchant keypair at boot.
 *
 * The guard is "neither half set" and the function publishes BOTH halves, so it is
 * idempotent and independent of who calls it first. Whichever of the server
 * (verifier) or the MCP client (signer) initializes earliest provisions the pair;
 * everyone else in the same process reuses it, so the private key the agent signs
 * with always matches the public key the server verifies against. This replaces the
 * old symmetric scheme's `default_agent_secret` fallback, which gave the same
 * zero-config parity but let anyone holding the "secret" forge requests.
 */
function ensureDevKeypair() {
  if (!process.env.AGENT_PUBLIC_KEY && !process.env.AGENT_PRIVATE_KEY) {
    const kp = generateEd25519KeyPair();
    process.env.AGENT_PUBLIC_KEY = kp.publicKey;
    process.env.AGENT_PRIVATE_KEY = kp.privateKey;
  }
}

/**
 * Agent signer: resolve the private key to sign a request with.
 *
 * If a public key is configured but no private key, this process was provisioned
 * as a verifier (server), not as the agent — refuse to sign rather than mint a key
 * the server will reject, so the misconfiguration fails loud instead of producing
 * signatures nobody can verify. Otherwise fall through to dev provisioning.
 */
function resolveAgentPrivateKey() {
  if (!process.env.AGENT_PRIVATE_KEY && process.env.AGENT_PUBLIC_KEY) {
    throw new Error('resolveAgentPrivateKey: AGENT_PRIVATE_KEY is not configured for this agent process');
  }
  ensureDevKeypair();
  return process.env.AGENT_PRIVATE_KEY;
}

/**
 * Agent side: build the X-Agorio-Signature header value for a request.
 * `t` and `nonce` are injectable for tests; they default to a fresh timestamp
 * and random nonce.
 *
 * @returns {string} `t=<ms>,nonce=<hex>,sig=<detachedJws>`
 */
function signRequest({ method, path, agentId, principalId, body, privateKey, t, nonce }) {
  if (!privateKey) {
    throw new Error('signRequest: AGENT_PRIVATE_KEY is not configured');
  }
  const ts = String(t !== undefined ? t : Date.now());
  const n = nonce !== undefined ? nonce : crypto.randomBytes(8).toString('hex');
  const bodyHash = canonicalBodyHash(method, body);
  const payload = buildSignedPayload({ method, path, agentId, principalId, t: ts, nonce: n, bodyHash });
  const sig = signEdDSA(payload, privateKey);
  return `t=${ts},nonce=${n},sig=${sig}`;
}

/**
 * Server side: verify an X-Agorio-Signature header.
 *
 * Returns `{ ok: true }` or `{ ok: false, status, code, message }` using the same
 * codes/statuses the inline HMAC check used, so callers map failures to responses
 * without special-casing. Fails closed on a missing/misconfigured public key.
 *
 * @param {object} args
 * @param {string} args.header      raw X-Agorio-Signature value
 * @param {string} args.method      req.method
 * @param {string} args.path        req.originalUrl (must match what the agent signed)
 * @param {string} args.agentId     attestation.agent_id (bound into the signature)
 * @param {string} args.principalId attestation.principal_id (bound into the signature)
 * @param {*}      args.body        parsed request body
 * @param {string} args.publicKey   AGENT_PUBLIC_KEY (PEM)
 * @param {number} [args.now]       injectable clock for tests
 */
function verifyRequest({ header, method, path, agentId, principalId, body, publicKey, now = Date.now() }) {
  if (typeof header !== 'string' || header.length === 0) {
    return { ok: false, status: 401, code: 'SIGNATURE_REQUIRED', message: 'Missing X-Agorio-Signature header' };
  }

  const parts = header.split(',').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    // slice at the FIRST '=' only: the detached-JWS sig value is base64url and
    // carries no '=', but splitting on every '=' would still be fragile.
    acc[part.slice(0, idx).trim()] = part.slice(idx + 1);
    return acc;
  }, {});

  const { t, nonce, sig } = parts;
  if (!t || !nonce || !sig) {
    return { ok: false, status: 400, code: 'INVALID_SIGNATURE', message: 'Invalid X-Agorio-Signature format' };
  }

  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts) || now - ts > SIGNATURE_TTL_MS) {
    return { ok: false, status: 401, code: 'SIGNATURE_EXPIRED', message: 'Signature has expired' };
  }

  if (!publicKey) {
    // Misconfiguration must never authenticate an agent. Fail closed.
    return { ok: false, status: 401, code: 'INVALID_SIGNATURE', message: 'Signature verification failed' };
  }

  const bodyHash = canonicalBodyHash(method, body);
  const payload = buildSignedPayload({ method, path, agentId, principalId, t, nonce, bodyHash });

  if (!verifyEdDSA(payload, sig, publicKey)) {
    return { ok: false, status: 403, code: 'INVALID_SIGNATURE', message: 'Signature verification failed' };
  }

  return { ok: true };
}

module.exports = {
  SIGNATURE_TTL_MS,
  buildSignedPayload,
  canonicalBodyHash,
  ensureDevKeypair,
  resolveAgentPrivateKey,
  signRequest,
  verifyRequest,
};
