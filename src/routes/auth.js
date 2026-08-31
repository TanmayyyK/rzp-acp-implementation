'use strict';

const express = require('express');
const db = require('../db');
const webauthn = require('../circle/webauthn');

const router = express.Router();

// Helper to get or set a dummy user. In a real app, this would be tied to an authenticated session for registration.
// For demonstration, we'll accept a principal_id from the query or body, or default to 'usr_alice'.
function getCircleUser(req) {
  const id = req.query.principal_id || req.body.principal_id || 'usr_alice';
  return {
    id,
    username: id,
    displayName: id,
  };
}

// GET /auth/register/generate
router.get('/register/generate', async (req, res) => {
  try {
    const user = getCircleUser(req);
    // Check if user already has a credential
    const row = db.prepare('SELECT * FROM webauthn_credentials WHERE principal_id = ?').get(user.id);
    if (row) {
      user.credentials = [{
        id: row.credential_id,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      }];
    }

    const options = await webauthn.generateRegOptions(user);
    
    // Store challenge in session
    req.session.currentChallenge = options.challenge;
    req.session.principal_id = user.id;

    res.json(options);
  } catch (err) {
    console.error('generateRegOptions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/register/verify
router.post('/register/verify', async (req, res) => {
  try {
    const expectedChallenge = req.session.currentChallenge;
    const principal_id = req.session.principal_id;
    
    if (!expectedChallenge || !principal_id) {
      return res.status(400).json({ error: 'No active registration session found' });
    }

    const response = req.body;
    const verification = await webauthn.verifyRegResponse(response, expectedChallenge);
    
    if (verification.verified && verification.authenticator) {
      const { credentialID, credentialPublicKey, counter, transports } = verification.authenticator;
      
      try {
        db.prepare(`
          INSERT INTO webauthn_credentials (principal_id, credential_id, public_key, counter, transports)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          principal_id,
          credentialID,
          credentialPublicKey,
          counter,
          transports ? JSON.stringify(transports) : null
        );
      } catch (err) {
        if (err.code && err.code.startsWith('SQLITE_CONSTRAINT')) {
          return res.status(409).json({ error: 'Credential already exists for this principal' });
        }
        throw err;
      }
      
      // Clear challenge
      req.session.currentChallenge = null;
      return res.json({ success: true, verified: true });
    }
    
    res.status(400).json({ success: false, verified: false });
  } catch (err) {
    console.error('verifyRegResponse error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/login/generate
router.get('/login/generate', async (req, res) => {
  try {
    const user = getCircleUser(req);
    const row = db.prepare('SELECT * FROM webauthn_credentials WHERE principal_id = ?').get(user.id);
    
    if (!row) {
      return res.status(404).json({ error: 'User is not registered' });
    }
    
    user.credentials = [{
      id: row.credential_id,
      transports: row.transports ? JSON.parse(row.transports) : undefined,
    }];

    const options = await webauthn.generateAuthOptions(user);
    
    req.session.currentChallenge = options.challenge;
    req.session.login_principal_id = user.id;

    res.json(options);
  } catch (err) {
    console.error('generateAuthOptions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/login/verify
router.post('/login/verify', async (req, res) => {
  try {
    const expectedChallenge = req.session.currentChallenge;
    const principal_id = req.session.login_principal_id;
    
    if (!expectedChallenge || !principal_id) {
      return res.status(400).json({ error: 'No active login session found' });
    }

    const row = db.prepare('SELECT * FROM webauthn_credentials WHERE principal_id = ?').get(principal_id);
    if (!row) {
      return res.status(404).json({ error: 'User is not registered' });
    }

    const authenticator = {
      credentialID: row.credential_id,
      credentialPublicKey: row.public_key,
      counter: row.counter,
      transports: row.transports ? JSON.parse(row.transports) : undefined,
    };

    const response = req.body;
    const verification = await webauthn.verifyAuthResponse(response, expectedChallenge, authenticator);
    
    if (verification.verified) {
      // Update the counter to prevent replay attacks
      db.prepare('UPDATE webauthn_credentials SET counter = ? WHERE principal_id = ?').run(
        verification.newCounter,
        principal_id
      );

      // Create an authenticated HTTP-only session cookie for the human
      req.session.authenticated = true;
      req.session.principal_id = principal_id; // Explicitly identify the principal_id of the human
      req.session.currentChallenge = null;
      req.session.login_principal_id = null;

      return res.json({ success: true, verified: true, principal_id });
    }

    res.status(400).json({ success: false, verified: false });
  } catch (err) {
    console.error('verifyAuthResponse error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
