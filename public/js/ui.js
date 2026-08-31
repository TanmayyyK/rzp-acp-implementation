/**
 * ui.js — cross-cutting UI shell: transient toasts, global keyboard shortcuts,
 * and an accessible shortcuts overlay (window.UI).
 *
 * View-only by construction: it never posts to /chat or writes to the audit
 * chain. Keyboard shortcuts drive the existing header buttons via .click(), so
 * there is exactly one code path per action (theme toggle, new chat, Trust
 * Center) — this layer just adds a keyboard entry point and never duplicates
 * their logic. Loaded after store/theme/chat/trust so those globals exist.
 */
(function () {
  'use strict';

  // ── icons (stroke set, matched to the rest of the console) ───────────────
  var ICON = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16v-4M12 8h.01"/><circle cx="12" cy="12" r="10"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    keyboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
  };

  function el(tag, className, props) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'html') node.innerHTML = props[k];
      else if (k === 'text') node.textContent = props[k];
      else node.setAttribute(k, props[k]);
    });
    return node;
  }

  // ── Toasts ───────────────────────────────────────────────────────────────
  // A single polite live region: toasts are announced to screen readers and
  // auto-dismiss, but never steal focus (toast-accessibility).
  var host = null;
  function toastHost() {
    if (host) return host;
    host = el('div', 'toast-host', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.appendChild(host);
    return host;
  }

  function toast(message, opts) {
    opts = opts || {};
    var tone = opts.tone || 'info'; // success | error | info
    var h = toastHost();
    var t = el('div', 'toast toast-' + tone, { role: 'group' });
    t.appendChild(el('span', 'toast-icon', { html: ICON[tone] || ICON.info, 'aria-hidden': 'true' }));
    var body = el('div', 'toast-body');
    body.appendChild(el('div', 'toast-title', { text: opts.title || (tone === 'error' ? 'Something went wrong' : 'Notice') }));
    if (message) body.appendChild(el('div', 'toast-msg', { text: message }));
    t.appendChild(body);
    var close = el('button', 'toast-close', { type: 'button', 'aria-label': 'Dismiss', html: ICON.x });
    t.appendChild(close);
    h.appendChild(t);

    var timer = null;
    function dismiss() {
      if (timer) { window.clearTimeout(timer); timer = null; }
      if (!t.parentNode) return;
      t.classList.remove('is-in');
      window.setTimeout(function () { if (t.parentNode) t.remove(); }, 220);
    }
    close.addEventListener('click', dismiss);
    // hovering pauses auto-dismiss so a toast can be read/acted on
    t.addEventListener('mouseenter', function () { if (timer) { window.clearTimeout(timer); timer = null; } });
    t.addEventListener('mouseleave', function () { if (!timer && ttl > 0) timer = window.setTimeout(dismiss, 1800); });

    window.requestAnimationFrame(function () { t.classList.add('is-in'); });
    var ttl = opts.duration == null ? 4200 : opts.duration; // 3–5s per toast guidance
    if (ttl > 0) timer = window.setTimeout(dismiss, ttl);
    return dismiss;
  }

  // ── Shortcuts overlay ──────────────────────────────────────────────────────
  var SHORTCUTS = [
    { keys: ['/'], label: 'Focus the message box' },
    { keys: ['N'], label: 'New chat' },
    { keys: ['T'], label: 'Open the Trust Center' },
    { keys: ['D'], label: 'Toggle light / dark theme' },
    { keys: ['?'], label: 'Show this shortcuts panel' },
    { keys: ['Esc'], label: 'Close a panel or the message box' },
  ];

  var overlay = null, panel = null, closeBtn = null, lastFocused = null;

  function buildOverlay() {
    if (overlay) return;
    overlay = el('div', 'sc-backdrop', { hidden: 'hidden' });
    panel = el('div', 'sc-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts', hidden: 'hidden' });

    var head = el('div', 'sc-head');
    head.appendChild(el('h2', 'sc-title', { text: 'Keyboard shortcuts' }));
    closeBtn = el('button', 'sc-close', { type: 'button', 'aria-label': 'Close', html: ICON.x });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var list = el('div', 'sc-list');
    SHORTCUTS.forEach(function (s) {
      var row = el('div', 'sc-row');
      row.appendChild(el('span', 'sc-row-label', { text: s.label }));
      var keys = el('span', 'sc-keys');
      s.keys.forEach(function (k) { keys.appendChild(el('kbd', 'kbd', { text: k })); });
      row.appendChild(keys);
      list.appendChild(row);
    });
    panel.appendChild(list);

    overlay.addEventListener('click', closeShortcuts);
    closeBtn.addEventListener('click', closeShortcuts);
    // minimal focus trap: the panel's only control is Close
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') { e.preventDefault(); closeBtn.focus(); }
    });

    document.body.appendChild(overlay);
    document.body.appendChild(panel);
  }

  function overlayOpen() { return panel && !panel.hidden; }

  function openShortcuts() {
    buildOverlay();
    if (overlayOpen()) return;
    lastFocused = document.activeElement;
    overlay.hidden = false; panel.hidden = false;
    window.requestAnimationFrame(function () { overlay.classList.add('is-open'); panel.classList.add('is-open'); });
    closeBtn.focus();
  }

  function closeShortcuts() {
    if (!overlayOpen()) return;
    overlay.classList.remove('is-open'); panel.classList.remove('is-open');
    window.setTimeout(function () { overlay.hidden = true; panel.hidden = true; }, 200);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  // ── Global keyboard layer ──────────────────────────────────────────────────
  function isTyping() {
    var a = document.activeElement;
    if (!a) return false;
    var tag = a.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
  }
  function click(id) { var b = document.getElementById(id); if (b) b.click(); }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (overlayOpen()) { closeShortcuts(); return; }
      if (isTyping()) document.activeElement.blur();
      return;
    }
    // Never hijack browser/OS combinations; single-key shortcuts only apply when
    // the user is not composing text (so typing '/' or 'n' into a message is safe).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping()) return;

    switch (e.key) {
      case '/': e.preventDefault(); if (window.ChatPanel) window.ChatPanel.focus(); break;
      case 'n': case 'N': e.preventDefault(); click('new-chat-btn'); break;
      case 't': case 'T': e.preventDefault(); click('trust-btn'); break;
      case 'd': case 'D': e.preventDefault(); click('theme-toggle'); break;
      case '?': e.preventDefault(); openShortcuts(); break;
      default: break;
    }
  }

  window.UI = {
    toast: toast,
    openShortcuts: openShortcuts,
    init: function (opts) {
      opts = opts || {};
      document.addEventListener('keydown', onKeydown);
      // Discoverable entry point for the shortcuts panel (keyboard help button).
      if (opts.shortcutsBtn) opts.shortcutsBtn.addEventListener('click', openShortcuts);
    },
    ICON: ICON,
  };
})();
