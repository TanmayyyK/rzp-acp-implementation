'use strict';

/**
 * WebAuthn authorization boundary for the Agentic Commerce Protocol.
 *
 * Wraps @simplewebauthn/server to produce/verify registration and
 * authentication ceremonies. EdDSA (COSE alg -8, Ed25519) is preferred,
 * with ES256 (COSE alg -7) offered as a fallback for authenticators
 * that don't support Ed25519.
 *
 * Written against @simplewebauthn/server v10.x. If you're on v8/v9, the
 * `registrationInfo`/`authenticationInfo` shapes differ slightly (see
 * inline notes below) and will need small adjustments.
 *
 * Required environment variables:
 *   WEBAUTHN_RP_NAME  - Human-readable relying party name.
 *   WEBAUTHN_RP_ID    - Relying party ID (domain, no scheme/port).
 *   WEBAUTHN_ORIGIN   - Exact origin the browser will present (scheme+host[+port]).
 */

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const crypto = require('crypto');
const { canonicalize } = require('../../jcs-hmac');

const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Agentic Commerce Protocol';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || `https://${RP_ID}`;

/**
 * Deterministically hash a mandate (like a CartMandate) into a base64url challenge.
 * This guarantees the WebAuthn signature covers the exact transaction details.
 */
function generateTransactionChallenge(mandate) {
  const canonical = canonicalize(mandate);
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest();
  return hash.toString('base64url');
}

/**
 * @typedef {Object} CredentialRef
 * @property {string} id - Base64URL credential ID.
 * @property {import('@simplewebauthn/server').AuthenticatorTransportFuture[]} [transports]
 */

/**
 * @typedef {Object} CircleUser
 * @property {string} id - Stable, unique, non-PII user identifier.
 * @property {string} username
 * @property {string} [displayName]
 * @property {CredentialRef[]} [credentials] - Existing credentials
 *   (excluded from new registrations, allowed for authentication).
 */

/**
 * @typedef {Object} StoredAuthenticator
 * @property {string} credentialID - Base64URL credential ID.
 * @property {string} credentialPublicKey - Base64URL-encoded COSE public key.
 * @property {number} counter - Current signature counter.
 * @property {import('@simplewebauthn/server').AuthenticatorTransportFuture[]} [transports]
 */

/**
 * Generate registration ("attestation") options for a new credential.
 * Requests EdDSA (-8) as the primary algorithm with ES256 (-7) fallback,
 * and requires resident keys + user verification (discoverable, phishing-
 * resistant credentials).
 *
 * @param {CircleUser} user
 * @returns {Promise<import('@simplewebauthn/server').PublicKeyCredentialCreationOptionsJSON>}
 */
async function generateRegOptions(user) {
  if (!user || !user.id || !user.username) {
    throw new TypeError('generateRegOptions: user.id and user.username are required');
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(user.id, 'utf8'),
    userName: user.username,
    userDisplayName: user.displayName || user.username,
    attestationType: 'none',
    // Order is preference order: EdDSA first, ES256 fallback second.
    // This is what ultimately populates pubKeyCredParams as
    // [{ alg: -8, type: 'public-key' }, { alg: -7, type: 'public-key' }].
    supportedAlgorithmIDs: [-8, -7],
    excludeCredentials: (user.credentials || []).map((cred) => ({
      id: cred.id,
      transports: cred.transports,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    timeout: 60_000,
  });

  return options;
}

/**
 * Verify a registration response and extract the public key + credential
 * ID to persist for future authentication ceremonies.
 *
 * @param {import('@simplewebauthn/server').RegistrationResponseJSON} response
 * @param {string} expectedChallenge - The challenge issued in generateRegOptions.
 * @returns {Promise<{ verified: boolean, authenticator: StoredAuthenticator | null }>}
 */
async function verifyRegResponse(response, expectedChallenge) {
  if (!response || !expectedChallenge) {
    throw new TypeError('verifyRegResponse: response and expectedChallenge are required');
  }

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });

  const { verified, registrationInfo } = verification;

  if (!verified || !registrationInfo) {
    return { verified: false, authenticator: null };
  }

  // v10+: registrationInfo.credential.{id,publicKey,counter}
  // v8/v9: registrationInfo.{credentialID,credentialPublicKey,counter} (Buffers/strings)
  const { credential } = registrationInfo;

  const authenticator = {
    credentialID: credential.id,
    credentialPublicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: response.response.transports,
  };

  return { verified, authenticator };
}

/**
 * Generate authentication ("assertion") options for a returning user,
 * scoped to that user's known credential IDs.
 *
 * @param {CircleUser} user
 * @param {string} [challenge] - Optional base64url challenge (e.g. from generateTransactionChallenge)
 * @returns {Promise<import('@simplewebauthn/server').PublicKeyCredentialRequestOptionsJSON>}
 */
async function generateAuthOptions(user, challenge) {
  if (!user || !Array.isArray(user.credentials) || user.credentials.length === 0) {
    throw new TypeError('generateAuthOptions: user.credentials must be a non-empty array');
  }

  const opts = {
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: user.credentials.map((cred) => ({
      id: cred.id,
      transports: cred.transports,
    })),
    timeout: 60_000,
  };

  if (challenge) {
    // Hand the challenge over as raw bytes, not as a string.
    //
    // @simplewebauthn treats a string challenge as UTF-8 text and base64url-
    // encodes it, so `options.challenge` would come back as the *encoding of our
    // encoding*. The client then signs that double-encoded value while the
    // server later compares against the single-encoded one, and every
    // transaction assertion fails verification. Decoding to bytes here makes
    // `options.challenge` identical to the string we derived, so the value the
    // authenticator signs is the value generateTransactionChallenge produces.
    opts.challenge = Buffer.from(challenge, 'base64url');
  }

  const options = await generateAuthenticationOptions(opts);

  return options;
}

/**
 * Verify an authentication response against a previously stored
 * authenticator record. Callers are responsible for persisting the
 * returned `newCounter` to guard against cloned-authenticator replay.
 *
 * @param {import('@simplewebauthn/server').AuthenticationResponseJSON} response
 * @param {string} expectedChallenge - The challenge issued in generateAuthOptions.
 * @param {StoredAuthenticator} authenticator - The stored credential to verify against.
 * @returns {Promise<{ verified: boolean, newCounter: number | null }>}
 */
async function verifyAuthResponse(response, expectedChallenge, authenticator) {
  if (!response || !expectedChallenge || !authenticator) {
    throw new TypeError(
      'verifyAuthResponse: response, expectedChallenge, and authenticator are required'
    );
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: authenticator.credentialID,
      publicKey: Buffer.from(authenticator.credentialPublicKey, 'base64url'),
      counter: authenticator.counter,
      transports: authenticator.transports,
    },
    requireUserVerification: true,
  });

  const { verified, authenticationInfo } = verification;

  return {
    verified,
    newCounter: verified ? authenticationInfo.newCounter : null,
  };
}

module.exports = {
  generateRegOptions,
  verifyRegResponse,
  generateAuthOptions,
  verifyAuthResponse,
  generateTransactionChallenge,
};
