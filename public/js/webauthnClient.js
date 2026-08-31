/**
 * webauthnClient.js — the client half of every ceremony in this app.
 *
 * Built on the platform WebAuthn API (navigator.credentials) rather than a
 * script-tag bundle from a CDN. Two reasons, both about trust:
 *
 *   1. An unpinned third-party <script> in the path of a signing ceremony can
 *      change under you between page loads. The one thing that must not be
 *      swappable is the code that talks to the authenticator.
 *   2. The response shapes below are the ones this server's verifier actually
 *      accepts — the same JSON that tests/helpers/softAuthenticator.js produces
 *      and src/circle/webauthn.js verifies. They are pinned by our own tests
 *      instead of by a version range.
 *
 * The private key never reaches this file. It lives in the authenticator; all
 * that crosses here is a signature over a challenge the server chose.
 *
 * No framework, no bundler: a plain IIFE that attaches window.WebAuthnClient.
 */
(function () {
  'use strict';

  // ─── base64url <-> ArrayBuffer ───────────────────────────────────────────
  // The server speaks base64url JSON (PublicKeyCredential*OptionsJSON); the
  // platform API speaks ArrayBuffer. This is the whole translation layer.

  function b64urlToBuf(value) {
    var base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
    var padded = base64 + '==='.slice((base64.length + 3) % 4);
    var raw = atob(padded);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function bufToB64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunk = '';
    for (var i = 0; i < bytes.length; i++) chunk += String.fromCharCode(bytes[i]);
    return btoa(chunk).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function toDescriptors(list) {
    return (list || []).map(function (cred) {
      var descriptor = { id: b64urlToBuf(cred.id), type: 'public-key' };
      if (cred.transports) descriptor.transports = cred.transports;
      return descriptor;
    });
  }

  function isSupported() {
    return typeof navigator !== 'undefined'
      && !!navigator.credentials
      && typeof navigator.credentials.get === 'function'
      && typeof window.PublicKeyCredential === 'function';
  }

  /** Translate the browser's error into something a human can act on. */
  function describeError(err) {
    if (!err) return 'The ceremony was cancelled.';
    if (err.name === 'NotAllowedError') {
      return 'Cancelled, or the request timed out. Nothing was signed.';
    }
    if (err.name === 'InvalidStateError') {
      return 'This device is already registered for this account.';
    }
    if (err.name === 'SecurityError') {
      return 'The page origin does not match the server\'s expected origin (WEBAUTHN_ORIGIN).';
    }
    if (err.name === 'AbortError') return 'The ceremony was aborted.';
    return err.message || String(err);
  }

  // ─── Registration ────────────────────────────────────────────────────────

  /**
   * @param {object} optionsJSON PublicKeyCredentialCreationOptionsJSON from
   *   GET /auth/register/generate.
   * @returns {Promise<object>} RegistrationResponseJSON for POST /auth/register/verify.
   */
  async function register(optionsJSON) {
    if (!isSupported()) throw new Error('This browser has no WebAuthn support.');

    var publicKey = {
      challenge: b64urlToBuf(optionsJSON.challenge),
      rp: optionsJSON.rp,
      user: {
        id: b64urlToBuf(optionsJSON.user.id),
        name: optionsJSON.user.name,
        displayName: optionsJSON.user.displayName,
      },
      pubKeyCredParams: optionsJSON.pubKeyCredParams,
      excludeCredentials: toDescriptors(optionsJSON.excludeCredentials),
    };
    if (optionsJSON.timeout) publicKey.timeout = optionsJSON.timeout;
    if (optionsJSON.attestation) publicKey.attestation = optionsJSON.attestation;
    if (optionsJSON.authenticatorSelection) publicKey.authenticatorSelection = optionsJSON.authenticatorSelection;
    if (optionsJSON.extensions) publicKey.extensions = optionsJSON.extensions;

    var credential = await navigator.credentials.create({ publicKey: publicKey });
    if (!credential) throw new Error('The authenticator returned no credential.');
    var response = credential.response;

    var json = {
      id: credential.id,
      rawId: bufToB64url(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64url(response.clientDataJSON),
        attestationObject: bufToB64url(response.attestationObject),
      },
    };
    // Optional per spec, but src/circle/webauthn.js persists response.transports,
    // so send it when the authenticator reports it.
    if (typeof response.getTransports === 'function') {
      json.response.transports = response.getTransports();
    }
    if (typeof response.getPublicKeyAlgorithm === 'function') {
      json.response.publicKeyAlgorithm = response.getPublicKeyAlgorithm();
    }
    if (typeof response.getAuthenticatorData === 'function') {
      json.response.authenticatorData = bufToB64url(response.getAuthenticatorData());
    }
    if (credential.authenticatorAttachment) {
      json.authenticatorAttachment = credential.authenticatorAttachment;
    }
    return json;
  }

  // ─── Assertion ───────────────────────────────────────────────────────────

  /**
   * Sign a challenge the server chose.
   *
   * Used for login AND for every transaction-bound ceremony — the delegation
   * grant and the per-transaction approval both arrive as ordinary
   * PublicKeyCredentialRequestOptionsJSON whose challenge is derived from the
   * mandate being signed. That is what binds a signature to one exact mandate:
   * edit any field on the way back and the derived challenge no longer matches.
   *
   * @param {object} optionsJSON PublicKeyCredentialRequestOptionsJSON.
   * @returns {Promise<object>} AuthenticationResponseJSON.
   */
  async function authenticate(optionsJSON) {
    if (!isSupported()) throw new Error('This browser has no WebAuthn support.');

    var publicKey = {
      challenge: b64urlToBuf(optionsJSON.challenge),
      allowCredentials: toDescriptors(optionsJSON.allowCredentials),
    };
    if (optionsJSON.timeout) publicKey.timeout = optionsJSON.timeout;
    if (optionsJSON.rpId) publicKey.rpId = optionsJSON.rpId;
    if (optionsJSON.userVerification) publicKey.userVerification = optionsJSON.userVerification;
    if (optionsJSON.extensions) publicKey.extensions = optionsJSON.extensions;

    var credential = await navigator.credentials.get({ publicKey: publicKey });
    if (!credential) throw new Error('The authenticator returned no assertion.');
    var response = credential.response;

    var json = {
      id: credential.id,
      rawId: bufToB64url(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64url(response.clientDataJSON),
        authenticatorData: bufToB64url(response.authenticatorData),
        signature: bufToB64url(response.signature),
        userHandle: response.userHandle ? bufToB64url(response.userHandle) : null,
      },
    };
    if (credential.authenticatorAttachment) {
      json.authenticatorAttachment = credential.authenticatorAttachment;
    }
    return json;
  }

  window.WebAuthnClient = {
    isSupported: isSupported,
    register: register,
    authenticate: authenticate,
    describeError: describeError,
    b64urlToBuf: b64urlToBuf,
    bufToB64url: bufToB64url,
  };
})();
