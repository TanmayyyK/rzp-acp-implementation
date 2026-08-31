/**
 * trust.js — the Trust Center slide-over drawer (window.TrustDrawer).
 *
 * Replaces the old inspector.js + hashchain.js panels with one polished,
 * click-to-reveal surface. Subscribes to AuditStore (the single poller) and
 * renders four sections against the live chain:
 *   1. Integrity  — pass/fail status, Verify button (idle→verifying→valid/invalid),
 *                   and a "Simulate tampering" switch that breaks the last block.
 *   2. Mandate    — budget-utilization meter, expiry countdown, mandate JSON.
 *   3. Activity   — narrated event timeline (the FEED_TYPES subset), new rows animate in.
 *   4. Hash chain — block cards on a connector spine, expandable payloads, verify tones.
 *
 * open(highlightHash) scrolls to + pulses the matching block (the receipt chip
 * deep-links here via the block's real hash); the header button opens it plainly.
 *
 * Accessibility: role="dialog" aria-modal, ESC + backdrop close, focus moved in on
 * open and restored on close, and a lightweight Tab focus trap.
 */
(function () {
  'use strict';

  var S = window.AuditStore;

  var IX = {
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    loader: '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    bug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2M5 7l3 2M19 19l-3-2M5 19l3-2M20 13h-4M4 13h4M10 4l1 2M14 4l-1 2"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    chain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/></svg>',
  };

  function el(tag, className, props) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'html') node.innerHTML = props[k];
      else if (k === 'text') node.textContent = props[k];
      else if (k in node) node[k] = props[k];
      else node.setAttribute(k, props[k]);
    });
    return node;
  }

  function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    function p(n) { return String(n).padStart(2, '0'); }
    return p(h) + ':' + p(m) + ':' + p(sec);
  }
  function fmtStamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtTime(iso) {
    return new Date(iso || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Theme-aware JSON viewer (DOM nodes, so payload strings can't inject markup).
  function renderJson(value, container) {
    var t = typeof value;
    if (value === null) { container.appendChild(el('span', 'json-null', { text: 'null' })); return; }
    if (t === 'boolean') { container.appendChild(el('span', 'json-boolean', { text: String(value) })); return; }
    if (t === 'number') { container.appendChild(el('span', 'json-number', { text: String(value) })); return; }
    if (t === 'string') { container.appendChild(el('span', 'json-string', { text: value })); return; }
    if (Array.isArray(value)) {
      if (!value.length) { container.appendChild(document.createTextNode('[]')); return; }
      container.appendChild(document.createTextNode('[ '));
      value.forEach(function (item, i) { renderJson(item, container); if (i < value.length - 1) container.appendChild(document.createTextNode(', ')); });
      container.appendChild(document.createTextNode(' ]'));
      return;
    }
    var ul = el('ul', 'json-object');
    var keys = Object.keys(value);
    keys.forEach(function (key, i) {
      var li = el('li');
      li.appendChild(el('span', 'json-key', { text: key + ': ' }));
      renderJson(value[key], li);
      if (i < keys.length - 1) li.appendChild(document.createTextNode(','));
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  window.TrustDrawer = {
    init: function (opts) {
      var drawer = opts.drawer;
      var backdrop = opts.backdrop;
      var openBtn = opts.openBtn;
      if (!drawer || !backdrop) return;

      // ── interactive state (survives store re-renders) ────────────────────
      var isOpen = false;
      var lastFocused = null;
      var verifyState = 'idle'; // idle | verifying | valid | invalid
      var brokenAt = null;
      var tampering = false;
      var lastVerified = null;
      var expandedSeqs = new Set();
      var renderedActivity = new Set();
      // Activity is grouped by session_id so separate purchases read as separate
      // threads. Groups are built once and appended to incrementally.
      var sessionGroups = Object.create(null); // key → { itemsEl, countEl, statusEl, count }
      var sessionOrder = [];                    // group keys, first-seen order
      var colorIndex = 0;
      var SESSION_ACCENTS = ['#3395FF', '#7C6CF0', '#12A9A0', '#5B8DEF', '#A05CD6'];
      var chainSig = '';        // block-count/tamper signature to avoid needless re-render

      // derived
      var entries = [];
      var offline = false;
      var expiryMs = null;

      // ── scaffold ─────────────────────────────────────────────────────────
      drawer.innerHTML = '';
      var head = el('div', 'drawer-head');
      var titles = el('div', 'drawer-head-titles');
      titles.appendChild(el('div', 'drawer-eyebrow', { html: S.icon('shield') + '<span>Trust Center</span>' }));
      titles.appendChild(el('h2', 'drawer-title', { id: 'trust-title', text: 'Verifiable by design' }));
      var connChip = el('span', 'drawer-conn');
      titles.appendChild(connChip);
      head.appendChild(titles);
      var closeBtn = el('button', 'drawer-close', { type: 'button', 'aria-label': 'Close Trust Center', html: IX.x });
      head.appendChild(closeBtn);
      drawer.appendChild(head);

      var scroll = el('div', 'drawer-scroll');
      drawer.appendChild(scroll);

      function section(iconHtml, title) {
        var sec = el('section', 'tc-section');
        var h = el('div', 'tc-section-head', { html: '<span class="tc-section-icon">' + iconHtml + '</span><span>' + title + '</span>' });
        sec.appendChild(h);
        var body = el('div', 'tc-section-body');
        sec.appendChild(body);
        scroll.appendChild(sec);
        return body;
      }

      // 1 · Integrity
      var integrityBody = section(S.icon('shieldCheck'), 'Integrity');
      var integrityCard = el('div', 'integrity-card');
      var integrityStatus = el('div', 'integrity-status');
      var verifyBtn = el('button', 'verify-btn', { type: 'button' });
      var verifyStatus = el('p', 'verify-status');
      var tamperLabel = el('label', 'tamper-toggle');
      var tamperCb = el('input', '', { type: 'checkbox' });
      tamperLabel.appendChild(tamperCb);
      tamperLabel.appendChild(el('span', 'tamper-track', { html: '<span class="tamper-thumb"></span>' }));
      tamperLabel.appendChild(el('span', 'tamper-text', { html: IX.bug + ' Simulate tampering' }));
      integrityCard.appendChild(integrityStatus);
      integrityCard.appendChild(verifyBtn);
      integrityCard.appendChild(verifyStatus);
      integrityCard.appendChild(tamperLabel);
      integrityBody.appendChild(integrityCard);

      // 2 · Mandate
      var mandateBody = section(S.icon('shield'), 'Intent Mandate');
      var meter = el('div', 'meter');
      var meterLabels = el('div', 'meter-labels', { html: '<span>Budget utilization</span><span class="meter-text mono">—</span>' });
      var meterTrack = el('div', 'meter-track');
      var meterFill = el('div', 'meter-fill');
      meterTrack.appendChild(meterFill);
      meter.appendChild(meterLabels);
      meter.appendChild(meterTrack);
      mandateBody.appendChild(meter);
      var expiryRow = el('div', 'expiry-row', { html: '<span class="expiry-label">' + IX.clock + ' Expires in</span><span class="expiry-time mono">—</span>' });
      mandateBody.appendChild(expiryRow);
      var mandateJson = el('div', 'json-viewer');
      mandateJson.appendChild(el('span', 'json-empty', { text: 'No active intent mandate yet — ask the agent to buy something.' }));
      mandateBody.appendChild(mandateJson);
      var meterText = meterLabels.querySelector('.meter-text');
      var expiryTime = expiryRow.querySelector('.expiry-time');

      // 3 · Activity — grouped by session so separate purchases read distinctly
      var activityBody = section(IX.activity, 'Activity');
      var activityEmpty = el('div', 'tc-empty', { text: 'No transaction events yet.' });
      var activityGroups = el('div', 'activity-groups');
      activityBody.appendChild(activityEmpty);
      activityBody.appendChild(activityGroups);

      // 4 · Hash chain
      var chainBody = section(IX.chain, 'Hash chain');
      var chainList = el('ol', 'chain-list');
      chainBody.appendChild(chainList);

      // ── rendering ─────────────────────────────────────────────────────────
      function recomputeMandate() {
        var activeMandate = null, mandateSeq = -1;
        entries.forEach(function (e) {
          if (e.event_type === 'MANDATE_ISSUED' && e.payload && e.payload.mandate) {
            activeMandate = e.payload.mandate; mandateSeq = e.seq;
          }
        });
        var maxPaise = activeMandate && typeof activeMandate.max_paise === 'number' ? activeMandate.max_paise : null;
        expiryMs = activeMandate && activeMandate.expiry_timestamp ? Date.parse(activeMandate.expiry_timestamp) : null;

        // Spend = distinct money moved at/after the active mandate.
        var spentPaise = 0; var seen = new Set();
        entries.forEach(function (e) {
          if (e.event_type !== 'MONEY_ACTION') return;
          if (mandateSeq >= 0 && e.seq < mandateSeq) return;
          var p = e.payload || {};
          var ref = p.order_id || p.razorpay_order_id || p.id || e.seq;
          if (seen.has(ref)) return; seen.add(ref);
          var paise = S.amountPaiseOf(p);
          if (paise) spentPaise += paise;
        });

        // Meter
        if (maxPaise == null) {
          meterText.textContent = spentPaise > 0 ? S.formatPaise(spentPaise) + ' spent' : '—';
          meterFill.style.width = '0%';
          meterFill.style.background = 'var(--text-3)';
        } else {
          var pct = Math.min(100, Math.max(0, (spentPaise / maxPaise) * 100));
          meterFill.style.width = pct + '%';
          meterText.textContent = S.formatPaise(spentPaise) + ' / ' + S.formatPaise(maxPaise);
          meterFill.style.background = pct < 70 ? 'var(--trust)' : (pct < 90 ? 'var(--pending)' : 'var(--broken)');
        }

        // Mandate JSON
        mandateJson.innerHTML = '';
        if (activeMandate) renderJson(activeMandate, mandateJson);
        else mandateJson.appendChild(el('span', 'json-empty', { text: 'No active intent mandate yet — ask the agent to buy something.' }));
      }

      function tickExpiry() {
        if (expiryMs == null) { expiryTime.textContent = '—'; expiryTime.style.color = 'var(--text-3)'; return; }
        var rem = expiryMs - Date.now();
        if (rem <= 0) { expiryTime.textContent = 'Expired'; expiryTime.style.color = 'var(--broken)'; }
        else { expiryTime.textContent = fmtDuration(rem); expiryTime.style.color = rem > 10 * 60 * 1000 ? 'var(--trust)' : 'var(--pending)'; }
      }

      // The current terminal state of a session, from its latest status-bearing
      // event (last one wins → reflects where the session actually is now).
      function statusOf(e) {
        var p = e.payload || {};
        if (e.event_type === 'FAILURE') return { text: 'failed', tone: 'broken', icon: 'alert' };
        if (e.event_type === 'MONEY_ACTION') return { text: 'payment requested', tone: 'trust', icon: 'shieldCheck' };
        if (e.event_type === 'WEBHOOK_RECEIVED') {
          var ev = String(p.event || '');
          if (/fail|declin/i.test(ev)) return { text: 'declined', tone: 'broken', icon: 'alert' };
          if (/captur|paid|success/i.test(ev)) return { text: 'settled', tone: 'trust', icon: 'shieldCheck' };
          return null;
        }
        if (e.event_type === 'GUARDRAIL_DECISION') {
          var esc = p.decision === 'ESCALATE_TO_HUMAN' || p.outcome === 'FAIL';
          return esc ? { text: 'held', tone: 'pending', icon: 'guardrail' } : null;
        }
        return null;
      }

      function ensureGroup(key) {
        if (sessionGroups[key]) return sessionGroups[key];
        var accent = key === 'general' ? 'var(--neutral)' : SESSION_ACCENTS[colorIndex++ % SESSION_ACCENTS.length];
        var group = el('div', 'activity-group');
        group.style.setProperty('--session-accent', accent);
        var headEl = el('div', 'session-head');
        headEl.appendChild(el('span', 'session-dot'));
        headEl.appendChild(el('span', 'session-id', { text: key === 'general' ? 'General' : key }));
        var statusEl = el('span', 'session-status');
        headEl.appendChild(statusEl);
        var countEl = el('span', 'session-count', { text: '0' });
        headEl.appendChild(countEl);
        var itemsEl = el('ol', 'session-items');
        group.appendChild(headEl);
        group.appendChild(itemsEl);
        activityGroups.appendChild(group);
        var rec = { itemsEl: itemsEl, countEl: countEl, statusEl: statusEl, count: 0 };
        sessionGroups[key] = rec;
        sessionOrder.push(key);
        return rec;
      }

      function syncActivity() {
        var feed = entries.filter(function (e) { return S.FEED_TYPES.has(e.event_type); });
        activityEmpty.style.display = feed.length ? 'none' : 'block';
        feed.forEach(function (e) {
          if (renderedActivity.has(e.seq)) return;
          renderedActivity.add(e.seq);
          var group = ensureGroup(e.session_id || 'general');
          var n = S.narrate(e);
          var v = S.feedView(e);
          var amount = v.amountPaise != null ? S.formatPaise(v.amountPaise) : '';

          // Built with DOM nodes (text via textContent) — payload/actor strings
          // can never inject markup, matching the JSON viewer's discipline.
          var li = el('li', 'activity-item');
          li.appendChild(el('span', 'activity-node tone-' + n.tone, { html: S.icon(n.icon) }));
          var main = el('span', 'activity-main');
          main.appendChild(el('span', 'activity-title', { text: n.title }));
          var metaEl = el('span', 'activity-meta');
          if (e.actor) metaEl.appendChild(el('span', 'mono', { text: e.actor }));
          metaEl.appendChild(el('span', 'activity-time', { text: fmtTime(e.timestamp) }));
          main.appendChild(metaEl);
          li.appendChild(main);
          if (amount) li.appendChild(el('span', 'activity-amount mono', { text: amount }));
          group.itemsEl.appendChild(li);

          group.count += 1;
          group.countEl.textContent = String(group.count);

          var st = statusOf(e);
          if (st) {
            group.statusEl.className = 'session-status tone-' + st.tone;
            group.statusEl.innerHTML = S.icon(st.icon);
            group.statusEl.appendChild(el('span', '', { text: st.text }));
          }
        });
      }

      function toneForIndex(index) {
        if (verifyState === 'valid') return 'ok';
        if (verifyState === 'invalid' && brokenAt !== null) {
          if (index === brokenAt) return 'broken';
          if (index > brokenAt) return 'suspect';
          return 'ok';
        }
        return 'idle';
      }

      function renderChain() {
        var sig = entries.length + '|' + verifyState + '|' + brokenAt + '|' + tampering + '|' + Array.from(expandedSeqs).sort().join(',');
        if (sig === chainSig) return;
        chainSig = sig;
        chainList.innerHTML = '';
        entries.forEach(function (block, index) {
          var li = el('li', 'chain-item');
          if (index > 0) {
            var tone = toneForIndex(index);
            var broken = tone === 'broken' || tone === 'suspect';
            var connector = el('div', 'chain-connector tone-' + tone, { html: S.icon(broken ? 'unlink' : 'link') + '<span class="chain-line"></span>' });
            li.appendChild(connector);
          }
          var blockTone = toneForIndex(index);
          var card = el('div', 'chain-block tone-' + blockTone, { 'data-hash': block.hash || '' });

          var bhead = el('div', 'chain-block-head');
          bhead.innerHTML =
            '<span class="chain-seq mono">#' + String(block.seq).padStart(4, '0') + '</span>' +
            '<span class="chain-event">' + block.event_type + '</span>' +
            '<span class="chain-block-time mono">' + fmtStamp(block.timestamp) + '</span>';
          if (blockTone === 'broken' || blockTone === 'suspect') bhead.appendChild(el('span', 'chain-flag', { text: 'unverifiable' }));
          card.appendChild(bhead);

          // Tamper view corrupts the last block's displayed hash (client-only).
          var displayHash = block.hash;
          var tamperedView = false;
          if (tampering && index === entries.length - 1 && entries.length > 0) {
            displayHash = 'deadbeef' + String(block.hash || '').slice(8);
            tamperedView = true;
          }
          var hashes = el('div', 'chain-hashes mono');
          var prevStr = index === 0 ? 'GENESIS' : S.truncateHash(block.prev_hash);
          hashes.innerHTML =
            '<span class="chain-hash-row">hash <span class="hash-val ' + (tamperedView ? 'is-bad' : 'is-hash') + '">' + S.truncateHash(displayHash) + '</span></span>' +
            '<span class="chain-hash-row">prev <span class="hash-val is-prev">' + prevStr + '</span></span>';
          card.appendChild(hashes);

          var toggle = el('button', 'chain-toggle', { type: 'button' });
          var expanded = expandedSeqs.has(block.seq);
          toggle.textContent = (expanded ? '▾' : '▸') + ' payload';
          var payload = el('div', 'chain-payload');
          if (expanded) {
            var jv = el('div', 'json-viewer');
            renderJson(block.payload, jv);
            payload.appendChild(jv);
          } else {
            payload.style.display = 'none';
          }
          toggle.addEventListener('click', function () {
            if (expandedSeqs.has(block.seq)) expandedSeqs.delete(block.seq);
            else expandedSeqs.add(block.seq);
            renderChain();
          });
          card.appendChild(toggle);
          card.appendChild(payload);

          li.appendChild(card);
          chainList.appendChild(li);
        });
      }

      function renderIntegrity() {
        var integ = S.integrity();
        verifyBtn.className = 'verify-btn state-' + verifyState;
        if (verifyState === 'idle') {
          verifyBtn.innerHTML = S.icon('shieldQuestion') + '<span>Verify chain integrity</span>';
          if (offline && entries.length === 0) {
            integrityStatus.className = 'integrity-status tone-neutral';
            integrityStatus.innerHTML = S.icon('shieldQuestion') +
              '<span><b>Not connected</b><small>Start the server to load the live audit chain</small></span>';
            verifyStatus.textContent = 'The audit server isn’t reachable right now.';
          } else {
            var passive = integ.valid !== false;
            integrityStatus.className = 'integrity-status tone-' + (passive ? 'trust' : 'broken');
            integrityStatus.innerHTML = (passive ? S.icon('shieldCheck') : S.icon('shieldAlert')) +
              '<span><b>' + (passive ? 'Chain intact' : 'Integrity violation') + '</b><small>' + entries.length + ' blocks · SHA-256 hash-linked' + (offline ? ' · offline (last known)' : '') + '</small></span>';
            verifyStatus.textContent = lastVerified ? 'Last verified at ' + fmtStamp(lastVerified) + '.' : 'Not yet verified in this session.';
          }
        } else if (verifyState === 'verifying') {
          verifyBtn.innerHTML = IX.loader + '<span>Verifying chain…</span>';
          integrityStatus.className = 'integrity-status tone-neutral';
          integrityStatus.innerHTML = IX.loader + '<span><b>Recomputing linkage…</b><small>Walking ' + entries.length + ' blocks</small></span>';
          verifyStatus.textContent = 'Recomputing hash linkage across the chain…';
        } else if (verifyState === 'valid') {
          verifyBtn.innerHTML = S.icon('shieldCheck') + '<span>Chain intact — ' + entries.length + ' blocks verified</span>';
          integrityStatus.className = 'integrity-status tone-trust';
          integrityStatus.innerHTML = S.icon('shieldCheck') + '<span><b>Chain intact</b><small>All ' + entries.length + ' blocks verified</small></span>';
          verifyStatus.textContent = 'All ' + entries.length + ' blocks verified at ' + fmtStamp(lastVerified) + '.';
        } else if (verifyState === 'invalid') {
          verifyBtn.innerHTML = S.icon('shieldAlert') + '<span>Integrity violation — block #' + (brokenAt != null ? brokenAt : '?') + '</span>';
          integrityStatus.className = 'integrity-status tone-broken';
          integrityStatus.innerHTML = S.icon('shieldAlert') + '<span><b>Integrity violation</b><small>Broken link at block #' + (brokenAt != null ? brokenAt : '?') + '</small></span>';
          verifyStatus.textContent = brokenAt != null && brokenAt >= 0
            ? 'prev_hash at block #' + brokenAt + " doesn't match hash at block #" + (brokenAt - 1) + '.'
            : 'Chain verification failed.';
        }
      }

      function renderConn() {
        connChip.className = 'drawer-conn ' + (offline ? 'is-offline' : 'is-live');
        connChip.innerHTML = '<span class="conn-dot"></span>' + (offline ? 'Offline' : 'Live');
      }

      // ── verify controls ────────────────────────────────────────────────────
      async function onVerify() {
        if (verifyState === 'verifying') return;
        verifyState = 'verifying'; brokenAt = null; renderIntegrity();
        if (tampering) {
          window.setTimeout(function () {
            verifyState = 'invalid';
            brokenAt = entries.length > 1 ? entries.length - 1 : 0;
            lastVerified = new Date().toISOString();
            renderIntegrity(); chainSig = ''; renderChain();
          }, 800);
          return;
        }
        var result = await S.verify();
        if (result.unavailable) {
          // Couldn't reach the server — don't fake a verdict.
          verifyState = 'idle';
          renderIntegrity();
          verifyStatus.textContent = 'Can’t verify — not connected to the audit server.';
          return;
        }
        lastVerified = new Date().toISOString();
        if (result.valid) { verifyState = 'valid'; brokenAt = null; }
        else { verifyState = 'invalid'; brokenAt = result.brokenAt; }
        renderIntegrity(); chainSig = ''; renderChain();
      }
      verifyBtn.addEventListener('click', onVerify);
      tamperCb.addEventListener('change', function (e) {
        tampering = e.target.checked;
        verifyState = 'idle'; brokenAt = null;
        renderIntegrity(); chainSig = ''; renderChain();
      });

      // ── store subscription ──────────────────────────────────────────────────
      S.subscribe(function (snap) {
        entries = snap.entries;
        offline = snap.offline;
        // New blocks invalidate a prior pass/fail verdict (matches the old panel).
        if (verifyState === 'valid' || verifyState === 'invalid') { verifyState = 'idle'; brokenAt = null; }
        recomputeMandate();
        tickExpiry();
        syncActivity();
        renderChain();
        renderIntegrity();
        renderConn();
      });

      // Expiry ticks every second, independent of the poll cadence.
      window.setInterval(tickExpiry, 1000);

      // ── open / close ─────────────────────────────────────────────────────────
      function focusables() {
        return Array.prototype.slice.call(drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
          .filter(function (n) { return !n.disabled && n.offsetParent !== null; });
      }
      function onKeydown(e) {
        if (e.key === 'Escape') { close(); return; }
        if (e.key === 'Tab') {
          var f = focusables();
          if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }

      function open(highlightHash) {
        if (!isOpen) {
          lastFocused = document.activeElement;
          isOpen = true;
          backdrop.hidden = false;
          drawer.setAttribute('aria-hidden', 'false');
          // next frame → CSS transition in
          requestAnimationFrame(function () {
            backdrop.classList.add('is-open');
            drawer.classList.add('is-open');
            document.body.classList.add('drawer-open');
          });
          document.addEventListener('keydown', onKeydown);
          closeBtn.focus();
        }
        if (highlightHash) highlight(highlightHash);
      }

      function close() {
        if (!isOpen) return;
        isOpen = false;
        backdrop.classList.remove('is-open');
        drawer.classList.remove('is-open');
        document.body.classList.remove('drawer-open');
        drawer.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', onKeydown);
        window.setTimeout(function () { if (!isOpen) backdrop.hidden = true; }, 320);
        if (lastFocused && lastFocused.focus) lastFocused.focus();
      }

      function highlight(hash) {
        // Expand + scroll to + pulse the block whose hash matches the receipt refId.
        var idx = entries.findIndex(function (e) { return e.hash === hash; });
        if (idx < 0) return;
        expandedSeqs.add(entries[idx].seq);
        chainSig = ''; renderChain();
        window.requestAnimationFrame(function () {
          var card = chainList.querySelector('.chain-block[data-hash="' + hash + '"]');
          if (!card) return;
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.remove('pulse');
          // reflow to restart the animation, then pulse
          void card.offsetWidth;
          card.classList.add('pulse');
          window.setTimeout(function () { card.classList.remove('pulse'); }, 1600);
        });
      }

      closeBtn.addEventListener('click', close);
      backdrop.addEventListener('click', close);
      if (openBtn) openBtn.addEventListener('click', function () { open(); });

      // expose
      this.open = open;
      this.close = close;
    },
  };
})();
