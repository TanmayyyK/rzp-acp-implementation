'use strict';

/**
 * A software WebAuthn authenticator for tests.
 *
 * This simulates the *hardware* side of the ceremony — a passkey living in a
 * phone's secure enclave — not the server's verifier. It produces genuine
 * Ed25519 assertions over a real clientDataJSON/authenticatorData pair, which
 * the unmodified production verifier (src/circle/webauthn.js) accepts. Nothing
 * in src/ is mocked, stubbed, or relaxed to make these tests pass: swap this
 * class for a real passkey and the server code does not change.
 *
 * That property is the point. It is what lets the server hold zero human
 * signing keys — the private key here never leaves the test process, exactly as
 * a real authenticator's never leaves the device.
 */

const crypto = require('crypto');

const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || `http://${RP_ID}:3000`;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

/**
 * Encode a raw Ed25519 public key as a COSE_Key map, the format WebAuthn
 * authenticators emit and @simplewebauthn parses.
 *
 *   a4                    map(4)
 *     01 01               kty(1): OKP(1)
 *     03 27               alg(3): EdDSA(-8)
 *     20 06               crv(-1): Ed25519(6)
 *     21 58 20 <32 bytes> x(-2): byte string, 32 bytes
 */
function coseEd25519PublicKey(rawPublicKey) {
  if (rawPublicKey.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${rawPublicKey.length}`);
  }
  return Buffer.concat([
    Buffer.from([0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21, 0x58, 0x20]),
    rawPublicKey,
  ]);
}

class SoftAuthenticator {
  /**
   * @param {object} [options]
   * @param {string} [options.rpId]
   * @param {string} [options.origin]
   * @param {number} [options.counter] Initial signature counter.
   */
  constructor({ rpId = RP_ID, origin = ORIGIN, counter = 0 } = {}) {
    this.rpId = rpId;
    this.origin = origin;
    this.counter = counter;

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    this.privateKey = privateKey;
    // Node exposes the raw 32-byte Ed25519 point as the JWK `x` parameter.
    this.rawPublicKey = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    this.cosePublicKey = coseEd25519PublicKey(this.rawPublicKey);

    this.credentialId = crypto.randomBytes(32).toString('base64url');
  }

  /** The row shape src/routes/auth.js persists after a successful registration. */
  credentialRow(principalId) {
    return {
      principal_id: principalId,
      credential_id: this.credentialId,
      public_key: this.cosePublicKey.toString('base64url'),
      counter: this.counter,
      transports: JSON.stringify(['internal']),
    };
  }

  /**
   * Insert this authenticator's public key directly into webauthn_credentials.
   *
   * The registration ceremony is not the boundary under test here — the
   * assertion is — so we persist the same row a real registration would and
   * move on. `db` is src/db.js.
   */
  register(db, principalId) {
    const row = this.credentialRow(principalId);
    db.prepare(
      `INSERT OR REPLACE INTO webauthn_credentials
         (principal_id, credential_id, public_key, counter, transports)
       VALUES (?, ?, ?, ?, ?)`
    ).run(row.principal_id, row.credential_id, row.public_key, row.counter, row.transports);
    return row;
  }

  /**
   * Produce a WebAuthn assertion over `challenge` (base64url).
   *
   * @param {string} challenge
   * @param {object} [opts]
   * @param {string} [opts.origin]    Override the origin (to test origin binding).
   * @param {boolean} [opts.userVerified=true] Clear the UV flag to test UV enforcement.
   * @param {number} [opts.counter]   Force a counter value (to test replay detection).
   * @returns {import('@simplewebauthn/server').AuthenticationResponseJSON}
   */
  sign(challenge, { origin, userVerified = true, counter } = {}) {
    if (typeof challenge !== 'string' || challenge.length === 0) {
      throw new TypeError('sign: challenge must be a non-empty base64url string');
    }

    this.counter = counter === undefined ? this.counter + 1 : counter;

    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: origin || this.origin,
        crossOrigin: false,
      }),
      'utf8'
    );

    // authenticatorData = rpIdHash(32) || flags(1) || signCount(4)
    // flags: 0x01 UP (user present) | 0x04 UV (user verified)
    const flags = Buffer.from([userVerified ? 0x05 : 0x01]);
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(this.counter, 0);
    const authenticatorData = Buffer.concat([sha256(Buffer.from(this.rpId, 'utf8')), flags, signCount]);

    // The authenticator signs authenticatorData || SHA256(clientDataJSON).
    const signature = crypto.sign(
      null,
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      this.privateKey
    );

    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: null,
      },
    };
  }
}

module.exports = { SoftAuthenticator, coseEd25519PublicKey };
