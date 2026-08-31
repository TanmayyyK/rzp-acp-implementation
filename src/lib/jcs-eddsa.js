'use strict';

const crypto = require('crypto');
const { canonicalize } = require('../../jcs-hmac');

function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/**
 * Signs a JCS canonicalized payload using an Ed25519 private key.
 * 
 * @param {object} payload - The object to sign (e.g. the mandate envelope without the proof).
 * @param {string} privateKeyPem - The Ed25519 private key in PEM format.
 * @returns {string} - The detached JWS base64url encoded signature.
 */
function signEdDSA(payload, privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const canonical = canonicalize(payload);
  
  // Ed25519 sign does not use a hash algorithm, so 'null' is passed.
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey);
  
  // Create a detached JWS format signature
  // JWS Header: {"alg":"EdDSA"} -> base64url = eyJhbGciOiJFZERTQSJ9
  const headerBase64url = 'eyJhbGciOiJFZERTQSJ9';
  const signatureBase64url = signature.toString('base64url');
  
  return `${headerBase64url}..${signatureBase64url}`;
}

/**
 * Verifies an Ed25519 detached JWS signature against a JCS payload.
 * 
 * @param {object} payload - The object that was signed (without the proof).
 * @param {string} detachedJws - The signature e.g. "eyJhbGciOiJFZERTQSJ9..sig"
 * @param {string} publicKeyPem - The Ed25519 public key in PEM format.
 * @returns {boolean} - true if signature is valid, false otherwise.
 */
function verifyEdDSA(payload, detachedJws, publicKeyPem) {
  if (typeof detachedJws !== 'string' || !detachedJws.includes('..')) {
    return false;
  }
  
  const parts = detachedJws.split('..');
  if (parts.length !== 2) return false;
  
  const signatureBase64url = parts[1];
  
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    const canonical = canonicalize(payload);
    const signature = Buffer.from(signatureBase64url, 'base64url');
    
    return crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, signature);
  } catch {
    return false;
  }
}

module.exports = {
  generateEd25519KeyPair,
  signEdDSA,
  verifyEdDSA
};
