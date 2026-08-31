/**
 * delegation.js — the Security Hub: everything a human signs, in one place.
 *
 * Four ceremonies, all of them the same shape (the server proposes, the
 * authenticator signs, the server verifies):
 *
 *   Register        POST /auth/register/verify
 *   Authenticate    POST /auth/login/verify
 *   Delegate        POST /api/v1/mandates/intent      <- creates the agent's authority
 *   Approve         POST .../complete { approval_mandate }
 *
 * The third one is why this file exists. The agent's spending authority is a
 * delegation grant whose IntentMandate a human signed; src/mcp/merchantClient.js
 * looks that grant up itself and refuses to shop without one
 * (DELEGATION_GRANT_REQUIRED). There was no way to create one from the browser,
 * so the whole flow dead-ended there. The cap the human types below is the cap
 * the merchant enforces; nothing the agent says can widen it.
 *
 * The fourth handles the case where the grant alone is not enough — a charge
 * over the signed cap, or partial delegation, which is never autonomous. The
 * server refuses with 402 and records a GUARDRAIL_DECISION with
 * awaiting_approval; this panel watches the audit chain (via AuditStore, which
 * is already polling) and offers to sign for exactly that session.
 *
 * No framework, no bundler: a plain IIFE that attaches window.Delegation.
 */
(function () {
  'use strict';

  var els = {};
  var state = {
    authenticated: false,
    principalId: null,
    accountCapPaise: null,
    activeGrant: null,
    pendingApproval: null, // { sessionId, amountPaise }
    busy: false,
    message: null,
    tone: 'muted',
  };

  function paise(n) {
    return window.AuditStore ? window.AuditStore.formatPaise(n) : '₹' + n / 100;
  }

  function say(message, tone) {
    state.message = message;
    state.tone = tone || 'muted';
    render();
  }

  async function api(method, url, body, headers) {
    var init = {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    var res = await fetch(url, init);
    var payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null; // an empty or non-JSON body; the status still tells us enough
    }
    return { status: res.status, ok: res.ok, body: payload };
  }

  /** Pull the message out of either error envelope this app uses. */
  function errorText(result) {
    if (!result.body) return 'HTTP ' + result.status;
    if (result.body.error) {
      return typeof result.body.error === 'string'
        ? result.body.error
        : (result.body.error.message || result.body.error.code || 'Refused');
    }
    return result.body.message || 'HTTP ' + result.status;
  }

  /** Run a ceremony with the panel locked, so a double-click cannot double-sign. */
  async function guard(fn) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await fn();
    } catch (err) {
      say(window.WebAuthnClient.describeError(err), 'danger');
    } finally {
      state.busy = false;
      render();
    }
  }

  // ─── Ceremony 1: register this device ────────────────────────────────────

  function registerDevice() {
    return guard(async function () {
      var options = await api('GET', '/auth/register/generate');
      if (!options.ok) return say(errorText(options), 'danger');

      var attestation = await window.WebAuthnClient.register(options.body);
      var verified = await api('POST', '/auth/register/verify', attestation);
      if (!verified.ok || !verified.body.verified) return say(errorText(verified), 'danger');

      say('Device registered. Authenticate to continue.', 'trust');
    });
  }

  // ─── Ceremony 2: prove a human is here ──────────────────────────────────

  function authenticate() {
    return guard(async function () {
      var options = await api('GET', '/auth/login/generate');
      if (!options.ok) return say(errorText(options), 'danger');

      var assertion = await window.WebAuthnClient.authenticate(options.body);
      var verified = await api('POST', '/auth/login/verify', assertion);
      if (!verified.ok || !verified.body.verified) return say(errorText(verified), 'danger');

      state.authenticated = true;
      state.principalId = verified.body.principal_id;
      await loadGrants();
      say('Signed in as ' + state.principalId + '.', 'trust');
    });
  }

  // ─── Ceremony 3: delegate spending authority to the agent ────────────────

  function delegate() {
    return guard(async function () {
      var rupees = Number(els.capInput && els.capInput.value);
      if (!isFinite(rupees) || rupees <= 0) {
        return say('Enter a spending limit in rupees.', 'danger');
      }
      var maxAmountPaise = Math.round(rupees * 100);

      // The server proposes the exact envelope; the challenge is derived from
      // it, so the authenticator is signing these fields and not a bare nonce.
      var proposal = await api('POST', '/api/v1/mandates/intent/challenge', {
        max_amount_paise: maxAmountPaise,
      });
      if (!proposal.ok) return say(errorText(proposal), 'danger');

      var signedCap = proposal.body.intent_mandate.claims.constraints.max_amount;
      var assertion = await window.WebAuthnClient.authenticate(proposal.body.webauthn);

      // Echo the envelope back untouched. Any edit changes the derived challenge
      // and the assertion stops verifying.
      var issued = await api('POST', '/api/v1/mandates/intent', {
        intent_mandate: proposal.body.intent_mandate,
        assertion: assertion,
      });
      if (!issued.ok) return say(errorText(issued), 'danger');

      await loadGrants();
      say('Agent authorized up to ' + paise(signedCap) + '.', 'trust');
    });
  }

  function revoke() {
    if (!state.activeGrant) return;
    var mandateId = state.activeGrant.mandate_id;
    return guard(async function () {
      var result = await api('POST', '/api/v1/mandates/intent/' + mandateId + '/revoke');
      if (!result.ok) return say(errorText(result), 'danger');
      await loadGrants();
      say('Authority revoked. The agent can no longer spend.', 'trust');
    });
  }

  // ─── Ceremony 4: approve one transaction the grant does not cover ─────────

  function approvePending() {
    var pending = state.pendingApproval;
    if (!pending) return;
    return guard(async function () {
      var request = await api('GET', '/api/v1/checkout/sessions/' + pending.sessionId + '/approve/challenge');
      if (!request.ok) return say(errorText(request), 'danger');

      var mandate = request.body.approval_mandate;
      var assertion = await window.WebAuthnClient.authenticate(request.body.webauthn);

      // Re-drive /complete carrying the signed approval. ADR-007 requires the
      // header, and this is a fresh key on purpose: the refused attempt never
      // charged, so this is a new attempt rather than a replay of one.
      var done = await api('POST', '/api/v1/checkout/sessions/' + pending.sessionId + '/complete', {
        approval_mandate: Object.assign({}, mandate, {
          proof: { type: 'webauthn-assertion', response: assertion },
        }),
      }, { 'Idempotency-Key': 'idem_ui_' + crypto.randomUUID() });
      if (!done.ok) return say(errorText(done), 'danger');

      state.pendingApproval = null;
      say('Approved ' + paise(mandate.approved_amount) + '. Charge released.', 'trust');
    });
  }

  // ─── Server state ───────────────────────────────────────────────────────

  async function loadGrants() {
    var result = await api('GET', '/api/v1/mandates/intent');
    if (result.status === 401) {
      state.authenticated = false;
      state.activeGrant = null;
      render();
      return;
    }
    if (!result.ok) return;
    state.authenticated = true;
    state.principalId = result.body.principal_id;
    state.accountCapPaise = result.body.account_cap_paise;
    var activeId = result.body.active_mandate_id;
    state.activeGrant = activeId
      ? (result.body.grants || []).find(function (g) { return g.mandate_id === activeId; }) || null
      : null;
    render();
  }

  /**
   * A session whose completion was refused for want of a human signature. Read
   * off the audit chain rather than a side channel: the chain is the record of
   * what the server decided, and a later success for the same session clears it.
   */
  function readPendingApproval(entries) {
    var pending = null;
    entries.forEach(function (entry) {
      var payload = entry.payload || {};
      if (entry.event_type === 'GUARDRAIL_DECISION' && payload.awaiting_approval && entry.session_id) {
        pending = { sessionId: entry.session_id, amountPaise: payload.amount_paise };
      } else if (entry.event_type === 'MONEY_ACTION' && pending && entry.session_id === pending.sessionId) {
        pending = null; // it went through
      }
    });
    return pending;
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  function button(id, label, opts) {
    var extra = (opts && opts.primary)
      ? 'background: var(--color-accent, #3b82f6); color: #fff; border-color: transparent;'
      : '';
    return '<button class="sidebar-item" id="' + id + '" type="button"'
      + (state.busy ? ' disabled' : '')
      + ' style="justify-content: center; font-size: 0.85rem;' + extra + '">'
      + label + '</button>';
  }

  function render() {
    if (!els.root) return;
    var html = '';

    if (!window.WebAuthnClient.isSupported()) {
      els.root.innerHTML = '<div style="font-size: 0.8rem; opacity: 0.7;">'
        + 'This browser has no WebAuthn support, so nothing here can be signed.</div>';
      return;
    }

    if (!state.authenticated) {
      html += button('sec-register', 'Register device');
      html += button('sec-auth', 'Authenticate', { primary: true });
    } else {
      html += '<div style="font-size: 0.8rem; color: var(--color-success, #10b981); font-weight: 600; text-align: center;">'
        + 'Human authenticated - ' + state.principalId + '</div>';

      if (state.activeGrant) {
        html += '<div style="font-size: 0.78rem; opacity: 0.85; line-height: 1.5;">'
          + 'Agent may spend up to <strong>' + paise(state.activeGrant.max_amount_paise) + '</strong>'
          + '<br />until ' + new Date(state.activeGrant.expires_at).toLocaleString()
          + '</div>';
        html += button('sec-revoke', 'Revoke authority');
      } else {
        html += '<label style="font-size: 0.78rem; opacity: 0.8;">Spending limit (₹)'
          + '<input id="sec-cap" type="number" min="1" step="1" value="10000"'
          + ' style="width: 100%; margin-top: 4px; padding: 6px 8px; border-radius: 6px;'
          + ' border: 1px solid var(--color-border, #d4d4d8); background: transparent;'
          + ' color: inherit; font-size: 0.85rem;" /></label>';
        if (state.accountCapPaise) {
          html += '<div style="font-size: 0.72rem; opacity: 0.6;">Account ceiling '
            + paise(state.accountCapPaise) + '</div>';
        }
        html += button('sec-delegate', 'Delegate spending', { primary: true });
      }

      if (state.pendingApproval) {
        html += '<div style="font-size: 0.78rem; padding: 8px; border-radius: 6px;'
          + ' background: var(--color-warn-bg, rgba(245, 158, 11, 0.12)); line-height: 1.45;">'
          + 'A charge of <strong>' + paise(state.pendingApproval.amountPaise) + '</strong>'
          + ' needs your signature.</div>';
        html += button('sec-approve', 'Sign approval', { primary: true });
      }
    }

    if (state.message) {
      var colour = state.tone === 'danger'
        ? 'var(--color-danger, #ef4444)'
        : state.tone === 'trust' ? 'var(--color-success, #10b981)' : 'inherit';
      html += '<div style="font-size: 0.75rem; line-height: 1.45; color: ' + colour + ';">'
        + state.message + '</div>';
    }

    els.root.innerHTML = html;
    els.capInput = document.getElementById('sec-cap');
    bind('sec-register', registerDevice);
    bind('sec-auth', authenticate);
    bind('sec-delegate', delegate);
    bind('sec-revoke', revoke);
    bind('sec-approve', approvePending);
  }

  function bind(id, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  }

  function init(options) {
    els.root = options.root;
    render();
    // Was a human already signed in from a previous page load? The cookie is
    // HTTP-only, so the server is the only one who can answer.
    loadGrants();

    if (window.AuditStore) {
      window.AuditStore.subscribe(function (snap) {
        var pending = readPendingApproval(snap.entries || []);
        var before = state.pendingApproval && state.pendingApproval.sessionId;
        var after = pending && pending.sessionId;
        if (before !== after) {
          state.pendingApproval = pending;
          render();
        }
      });
    }
  }

  window.Delegation = {
    init: init,
    refresh: loadGrants,
  };
})();
