/**
 * theme.js — light/dark toggle wiring + persistence.
 *
 * The initial data-theme is set by an inline boot script in dashboard.html
 * (before first paint, so there's no flash) — light by default. This module
 * only owns the toggle button: reflecting the current theme, flipping it, and
 * persisting the choice (dark is an explicit, remembered opt-in).
 *
 * window.Theme.init(button) is called on DOMContentLoaded.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'acp-theme';

  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';

  function current() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function apply(theme, btn) {
    document.documentElement.setAttribute('data-theme', theme);
    if (btn) {
      // The button shows the theme you'd switch TO.
      btn.innerHTML = theme === 'dark' ? SUN : MOON;
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.setAttribute('title', theme === 'dark' ? 'Light mode' : 'Dark mode');
    }
  }

  function persist(theme) {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (_e) { /* private mode: session-only */ }
  }

  window.Theme = {
    init: function (btn) {
      apply(current(), btn);

      if (btn) {
        btn.addEventListener('click', function () {
          var next = current() === 'dark' ? 'light' : 'dark';
          // Briefly enable a cross-fade on the root, then apply.
          document.documentElement.classList.add('theme-animating');
          apply(next, btn);
          persist(next);
          window.setTimeout(function () {
            document.documentElement.classList.remove('theme-animating');
          }, 320);
        });
      }
    },
    current: current,
  };
})();
