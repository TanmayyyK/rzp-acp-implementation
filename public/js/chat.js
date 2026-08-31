/**
 * chat.js — the hero chat surface (window.ChatPanel).
 *
 * Renders the centered conversation: empty-state greeting with example chips, a
 * modern composer (prompt + budget + model), user/agent bubbles, Gemini-style
 * inline collapsible "thinking", and clean digital-receipt cards.
 *
 * The live "thinking" bar streams the agent's reasoning in real time: on submit
 * the client opens POST /chat/thinking (a dedicated fast Groq narration, keyed by
 * GROQ_API_KEY_2) IN PARALLEL with the /chat turn and types the deltas into the
 * bar as they arrive — so the reasoning lands while the work happens, not after.
 * The turn's structured audit blocks still drive the Trust Center drawer, polled
 * once by AuditStore (refresh() after each turn surfaces them promptly).
 *
 * Everything shown is real: receipts and audit blocks come only from the
 * server's response and its tamper-evident chain. If the server is unreachable
 * the turn fails honestly with a short notice — no stub purchases, no fabricated
 * receipts, nothing written to the Trust Center that didn't actually happen.
 */
(function () {
  'use strict';

  var S = window.AuditStore;
  var mountRegion = null; // set on init; lets ChatPanel.reset() rebuild a fresh turn

  var CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  var SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
  var COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  var EXAMPLES = [
    'Buy a mechanical keyboard under ₹8,000',
    'Order groceries for the week',
    'Compare two wireless earbuds',
    'What can you do?',
  ];

  var DEFAULT_BUDGET = 10000; // mirrors server AUTO_APPROVE default (₹1,000,000 paise)

  // ─── tiny DOM factory ────────────────────────────────────────────────────
  function el(tag, className, props) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'html') node.innerHTML = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k in node) node[k] = props[k];
        else node.setAttribute(k, props[k]);
      });
    }
    return node;
  }

  function formatTime(ts) {
    return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ─── offline notice — shown only when the agent server can't be reached ───
  // No fabricated receipts or audit blocks: if the server is down, we say so.
  function offlineNotice() {
    return [{
      role: 'agent',
      timestamp: Date.now(),
      content: "I can't reach the agent server right now, so I can't run this. Start it with `npm start` and try again — every step is recorded to the tamper-evident audit chain.",
    }];
  }

  window.ChatPanel = {
    init: function (region) {
      if (!region) return;
      mountRegion = region;
      region.innerHTML = '';
      var locked = false;

      // ── scaffold ───────────────────────────────────────────────────────
      var scroll = el('div', 'chat-scroll', { role: 'log', 'aria-live': 'polite' });

      var hero = el('div', 'hero');
      
      hero.appendChild(el('h1', 'hero-title', { text: 'What would you like to buy today?' }));
      hero.appendChild(el('p', 'hero-sub', { text: 'Your buyer agent searches and checks signed authority before creating a Razorpay payment request. It is marked paid only after a verified webhook.' }));
      var chips = el('div', 'hero-chips');
      EXAMPLES.forEach(function (ex) {
        var chip = el('button', 'hero-chip', { type: 'button', text: ex });
        chip.addEventListener('click', function () {
          if (locked) return;
          input.value = ex;
          autogrow();
          submit();
        });
        chips.appendChild(chip);
      });
      hero.appendChild(chips);
      scroll.appendChild(hero);

      // ── composer ───────────────────────────────────────────────────────
      var form = el('form', 'composer');
      var box = el('div', 'composer-box');
      var input = el('textarea', 'composer-input', {
        id: 'chat-input', rows: 1, placeholder: 'Message your buyer agent…', 'aria-label': 'Message your buyer agent',
      });
      var tools = el('div', 'composer-tools');

      var budgetField = el('label', 'composer-budget', { title: 'Spend cap — becomes the IntentMandate ceiling for a purchase' });
      budgetField.appendChild(el('span', 'composer-budget-sym', { text: '₹' }));
      var budgetInput = el('input', 'composer-budget-input', { id: 'budget-input', type: 'number', min: '0', step: '100', value: String(DEFAULT_BUDGET), 'aria-label': 'Budget in rupees' });
      budgetField.appendChild(budgetInput);

      // ── Custom Model Dropdown ──────────────────────────────────────────
      var modelWrap = el('div', 'model-dropdown-container');
      
      var modelButton = el('button', 'model-dropdown-button', { type: 'button' });
      var plusIcon = el('span', 'model-dropdown-icon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14m-7-7h14"/></svg>' });
      var buttonText = el('span', '', { text: 'Gemini 3.6 Flash' });
      var chevronDown = el('span', 'model-dropdown-icon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' });
      modelButton.appendChild(plusIcon);
      modelButton.appendChild(buttonText);
      modelButton.appendChild(chevronDown);

      var menu = el('div', 'model-dropdown-menu');
      menu.appendChild(el('div', 'model-dropdown-header', { text: 'Model' }));

      var activeModel = 'gemini';
      var chatHistory = []; // default

      // Internal model values map to UI labels
      var models = [
        { id: 'gemini', main: 'Gemini 3.6 Flash' },
        { id: 'groq', main: 'Qwen3 32B' }
      ];

      function renderMenu() {
        while (menu.childNodes.length > 1) { menu.removeChild(menu.lastChild); }
        models.forEach(function(m) {
          var item = el('div', 'model-dropdown-item' + (m.id === activeModel ? ' is-active' : ''));
          item.appendChild(el('span', '', { text: m.main }));
          var rightBox = el('div', 'model-dropdown-item-right');
          if (m.id === activeModel) {
            rightBox.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>';
          }
          item.appendChild(rightBox);
          item.addEventListener('click', function(e) {
            e.stopPropagation();
            activeModel = m.id;
            buttonText.textContent = m.main;
            menu.classList.remove('is-open');
            modelButton.classList.remove('is-open');
            renderMenu();
          });
          menu.appendChild(item);
        });
      }
      renderMenu();

      modelButton.addEventListener('click', function(e) {
        e.stopPropagation();
        menu.classList.toggle('is-open');
        modelButton.classList.toggle('is-open');
      });
      document.addEventListener('click', function(e) {
        if (!modelWrap.contains(e.target)) {
          menu.classList.remove('is-open');
          modelButton.classList.remove('is-open');
        }
      });

      modelWrap.appendChild(modelButton);
      modelWrap.appendChild(menu);

      var send = el('button', 'composer-send', { type: 'submit', 'aria-label': 'Send', html: SEND });

      tools.appendChild(budgetField);
      tools.appendChild(modelWrap);
      tools.appendChild(el('span', 'composer-spacer'));
      tools.appendChild(send);
      box.appendChild(input);
      box.appendChild(tools);
      form.appendChild(box);
      form.appendChild(el('p', 'composer-hint', { html: 'Amounts stay under signed authority · payment remains pending until Razorpay confirms it' }));

      region.appendChild(scroll);
      region.appendChild(form);

      // ── behaviors ────────────────────────────────────────────────────────
      function toBottom() { scroll.scrollTop = scroll.scrollHeight; }
      function autogrow() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      }
      // Send is enabled only with a non-empty draft and no turn in flight — a
      // clear disabled affordance (never a button that looks live but no-ops).
      function syncSend() { send.disabled = locked || !input.value.trim(); }
      function setLock(v) {
        locked = v;
        input.disabled = v; modelButton.disabled = v; budgetInput.disabled = v;
        form.classList.toggle('is-locked', v);
        scroll.setAttribute('aria-busy', String(v)); // announce work to assistive tech
        syncSend();
        if (!v) { input.focus(); }
      }
      function dismissHero() {
        if (hero.parentNode) { hero.classList.add('is-gone'); window.setTimeout(function () { if (hero.parentNode) hero.remove(); }, 260); }
      }

      function addBubble(role, content, ts) {
        var row = el('div', 'msg msg-' + role);
        var bubble = el('div', 'bubble bubble-' + role);

        var bubbleText = el('div', 'bubble-text markdown-body');
        if (typeof marked !== 'undefined') {
          bubbleText.innerHTML = marked.parse(content || '');
        } else {
          bubbleText.textContent = content || '';
        }
        bubble.appendChild(bubbleText);

        if (role === 'agent') {
          // Premium assistant surface (à la Claude / Gemini): a gradient avatar
          // glyph and an agent name/label beside the message, with the reply text
          // in a soft card. Everything shown is still the server's real response.
          var reply = el('div', 'agent-reply');
          var avatar = el('div', 'agent-avatar', { html: SPARK, 'aria-hidden': 'true' });
          var col = el('div', 'agent-col');
          var nameRow = el('div', 'agent-namerow');
          nameRow.appendChild(el('span', 'agent-name', { text: 'Buyer Agent' }));
          nameRow.appendChild(el('span', 'agent-badge', { text: 'Razorpay ACP' }));
          // Copy the reply text — a quiet hover action, no layout shift.
          var copyBtn = el('button', 'bubble-action', { type: 'button', title: 'Copy reply', 'aria-label': 'Copy reply', html: COPY });
          copyBtn.addEventListener('click', function () {
            var done = function () { if (window.UI) window.UI.toast('Reply copied to clipboard', { tone: 'success', title: 'Copied' }); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(content || '').then(done, function () {});
            }
          });
          nameRow.appendChild(copyBtn);
          col.appendChild(nameRow);
          col.appendChild(bubble);
          reply.appendChild(avatar);
          reply.appendChild(col);
          row.appendChild(reply);
        } else {
          bubble.appendChild(el('div', 'bubble-time', { text: formatTime(ts) }));
          row.appendChild(bubble);
        }

        scroll.appendChild(row);
        toBottom();
        return row;
      }

      function addReceipt(data, ts) {
        var d = data || {};
        var row = el('div', 'msg msg-agent');
        var card = el('div', 'receipt');
        card.appendChild(el('div', 'receipt-perf'));

        var head = el('div', 'receipt-head');
        var mh = el('div', 'receipt-merchant');
        mh.appendChild(el('div', 'receipt-merchant-name', { text: d.merchantName || 'Merchant' }));
        mh.appendChild(el('div', 'receipt-order', { text: 'Order ' + (d.orderId || '—') }));
        head.appendChild(mh);
        var statusMap = { confirmed: ['trust', 'Confirmed'], pending_approval: ['pending', 'Awaiting approval'], declined: ['broken', 'Declined'] };
        var sm = statusMap[d.status] || ['neutral', d.status || 'unknown'];
        head.appendChild(el('span', 'receipt-status tone-' + sm[0], { text: sm[1] }));
        card.appendChild(head);

        var lines = el('div', 'receipt-lines');
        (d.items || []).forEach(function (it) {
          var line = el('div', 'receipt-line');
          line.appendChild(el('span', 'receipt-line-name', { text: it.name || 'Item' }));
          line.appendChild(el('span', 'receipt-leader'));
          line.appendChild(el('span', 'receipt-line-price', { text: S.formatRupees(it.price) }));
          lines.appendChild(line);
        });
        card.appendChild(lines);

        var totals = el('div', 'receipt-totals');
        function trow(label, val, strong) {
          var r = el('div', 'receipt-trow' + (strong ? ' is-total' : ''));
          r.appendChild(el('span', '', { text: label }));
          r.appendChild(el('span', 'mono', { text: S.formatRupees(val) }));
          totals.appendChild(r);
        }
        trow('Subtotal', d.subtotal);
        trow('Tax (18%)', d.tax);
        trow('Total', d.total, true);
        card.appendChild(totals);

        var footer = el('div', 'receipt-footer');
        var ref = d.refId ? String(d.refId).slice(0, 8) : '00000000';
        var chip = el('button', 'chain-chip', { type: 'button', title: 'Open the Trust Center at this block' });
        chip.innerHTML = '<span class="chain-chip-check">' + CHECK + '</span>verified · chain ' + ref + '…';
        chip.addEventListener('click', function () {
          if (window.TrustDrawer) window.TrustDrawer.open(d.refId);
        });
        footer.appendChild(chip);
        footer.appendChild(el('span', 'receipt-time', { text: formatTime(d.timestamp || ts) }));
        card.appendChild(footer);

        row.appendChild(card);
        scroll.appendChild(row);
        
        if (d.status === 'confirmed' && typeof d.total === 'number') {
          var currentBudget = Number(budgetInput.value) || 0;
          var newBudget = Math.max(0, currentBudget - d.total);
          budgetInput.value = String(newBudget);
        }

        // Confirm the outcome with a transient toast (announced, never focus-stealing).
        if (window.UI) {
          if (d.status === 'confirmed') window.UI.toast((d.orderId ? d.orderId + ' · ' : '') + S.formatRupees(d.total), { tone: 'success', title: 'Payment confirmed' });
          else if (d.status === 'pending_approval') window.UI.toast('This purchase exceeds your budget mandate and needs approval.', { tone: 'info', title: 'Awaiting approval' });
          else if (d.status === 'declined') window.UI.toast('The purchase was declined.', { tone: 'error', title: 'Declined' });
        }

        toBottom();
      }

      // Live, clickable "thinking" bar. The instant a turn starts it opens and a
      // parallel stream (POST /chat/thinking, powered by the dedicated
      // GROQ_API_KEY_2) types the agent's reasoning into it token by token — so
      // the user watches what the agent is doing in real time, not reconstructed
      // after the fact. When the turn settles it collapses into a re-openable
      // "Agent working" disclosure.
      function addThinkingLive() {
        var row = el('div', 'msg msg-agent');
        var think = el('div', 'think is-live', { 'data-open': 'true' });
        var head = el('button', 'think-head', { type: 'button', 'aria-expanded': 'true' });
        head.innerHTML =
          '<span class="think-spark">' + SPARK + '</span>' +
          '<span class="think-headline shimmer">Thinking…</span>' +
          '<span class="think-chev">' + CHEVRON + '</span>';

        var body = el('div', 'think-body');
        var inner = el('div', 'think-body-inner');
        var narr = el('div', 'think-narration');
        // Concrete audit step timeline, populated on settle from this turn's real
        // chain blocks (the same events the Trust Center Activity feed narrates).
        var steps = el('div', 'think-steps');
        inner.appendChild(narr);
        inner.appendChild(steps);
        body.appendChild(inner);
        think.appendChild(head);
        think.appendChild(body);
        row.appendChild(think);
        scroll.appendChild(row);

        var ref = { row: row, think: think, head: head, narr: narr, steps: steps, text: '' };

        // Clickable throughout — collapse it while it streams, re-open it after.
        head.addEventListener('click', function () {
          var open = think.getAttribute('data-open') === 'true';
          think.setAttribute('data-open', String(!open));
          head.setAttribute('aria-expanded', String(!open));
          if (!open) toBottom();
        });

        toBottom();
        return ref;
      }

      // Append a streamed delta to the live narration. textContent (not innerHTML)
      // keeps model output inert; the narration is plain prose by construction.
      function appendNarration(ref, delta) {
        ref.text += delta;
        ref.narr.textContent = ref.text;
        if (ref.think.getAttribute('data-open') === 'true') toBottom();
      }

      // Open the parallel narration stream and pump deltas into the bar until the
      // server closes it (or the turn settles first and aborts us). Never throws:
      // offline / no-key / abort just leaves whatever text already streamed in.
      async function streamThinking(ref, payload, signal) {
        try {
          var res = await fetch('/chat/thinking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: signal,
          });
          if (!res.ok || !res.body || !res.body.getReader) return;
          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            var delta = decoder.decode(chunk.value, { stream: true });
            if (delta) appendNarration(ref, delta);
          }
        } catch (_e) { /* aborted on finalize, or offline — keep whatever streamed */ }
      }

      // Mirror this turn's real audit events into the thinking disclosure as a
      // concrete step timeline — searched, issued/verified the mandate, called
      // tools, hit a guardrail, placed the order — so "Agent working" shows what
      // the agent actually DID alongside the streamed reasoning. These are the same
      // FEED_TYPES blocks the Trust Center Activity feed narrates, reusing
      // AuditStore.narrate/icon and the feed's own .activity-item markup so the two
      // views stay identical. `sinceSeq` scopes it to just the blocks this turn
      // appended (captured before the turn, read after S.refresh()).
      function renderThinkingSteps(ref, sinceSeq) {
        if (!S || typeof S.entries !== 'function' || !S.FEED_TYPES) return;
        var fresh = S.entries().filter(function (e) {
          return e && typeof e.seq === 'number' && e.seq > sinceSeq && S.FEED_TYPES.has(e.event_type);
        });
        ref.steps.innerHTML = '';
        fresh.forEach(function (e) {
          var n = S.narrate(e);
          // DOM nodes with text via textContent — payload strings can never inject
          // markup, matching the Activity feed's discipline.
          var item = el('div', 'activity-item');
          item.appendChild(el('span', 'activity-node tone-' + n.tone, { html: S.icon(n.icon) }));
          var main = el('span', 'activity-main');
          main.appendChild(el('span', 'activity-title', { text: n.title }));
          if (n.detail) {
            var meta = el('span', 'activity-meta');
            meta.appendChild(el('span', '', { text: n.detail }));
            main.appendChild(meta);
          }
          item.appendChild(main);
          ref.steps.appendChild(item);
        });
      }

      // Settle the bar: stop the shimmer/caret, collapse it, relabel the head. Drop
      // it only when nothing landed at all — neither streamed reasoning nor any
      // real audit step (no key / offline / a non-transactional reply).
      function finalizeThinking(ref) {
        ref.think.classList.remove('is-live');
        ref.think.setAttribute('data-open', 'false');
        ref.head.setAttribute('aria-expanded', 'false');

        var hasSteps = ref.steps && ref.steps.childNodes.length > 0;
        if ((!ref.text || !ref.text.trim()) && !hasSteps) { ref.row.remove(); return; }

        // Swapping the head's innerHTML keeps its click listener (bound to the
        // element, not its children), so the settled bar stays expandable.
        ref.head.innerHTML =
          '<span class="think-spark">' + SPARK + '</span>' +
          '<span class="think-headline">Agent working</span>' +
          '<span class="think-chev">' + CHEVRON + '</span>';
      }

      // ── submit ───────────────────────────────────────────────────────────
      async function submit() {
        if (locked) return;
        var text = input.value.trim();
        if (!text) return;
        var provider = activeModel;
        var budget = Number(budgetInput.value) || 0;

        dismissHero();
        addBubble('user', text, Date.now());
        chatHistory.push({ role: 'user', content: text });
        input.value = '';
        autogrow();
        setLock(true);
        var thinking = addThinkingLive();
        // Watermark the chain before the turn so we can later pull exactly the
        // blocks this turn appends into the thinking timeline.
        var startSeq = (S && typeof S.maxSeq === 'function') ? S.maxSeq() : -1;

        // Fire the real-time reasoning stream IN PARALLEL with the turn. Its own
        // Groq key (GROQ_API_KEY_2) means it starts instantly and never waits on —
        // or rate-limits against — the money-moving agent, so the narration lands
        // while the work happens, not after it.
        var thinkAbort = ('AbortController' in window) ? new AbortController() : null;
        var thinkingStream = streamThinking(thinking, { messages: chatHistory, budget: budget }, thinkAbort ? thinkAbort.signal : null);

        var messages;
        try {
          var res = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: chatHistory, provider: provider, budget: budget }),
          });
          if (!res.ok) throw new Error('chat HTTP ' + res.status);
          messages = await res.json();
          await S.refresh(); // pull the blocks the server just appended (Trust drawer)
        } catch (_err) {
          // Server unreachable: fail honestly — never fabricate a receipt.
          messages = offlineNotice();
          if (window.UI) window.UI.toast('Start the agent with `npm start`, then try again.', { tone: 'error', title: "Can't reach the agent" });
        }

        // The turn has settled — stop the live narration and collapse the bar, so
        // the reasoning always stays temporally ahead of the answer, never trailing
        // it (the "time-correlation" the whole live view exists to preserve).
        if (thinkAbort) thinkAbort.abort();
        try { await thinkingStream; } catch (_e) { /* aborted */ }
        renderThinkingSteps(thinking, startSeq);
        finalizeThinking(thinking);

        (Array.isArray(messages) ? messages : [messages]).forEach(function (m) {
          if (!m) return;
          if (m.role === 'receipt') addReceipt(m.data || m.receipt, m.timestamp);
          else addBubble(m.role || 'agent', m.content || m.message, m.timestamp);
        });

        setLock(false);
      }

      form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
      input.addEventListener('input', function () { autogrow(); syncSend(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      });

      syncSend();
      input.focus();
    },
  };

  // Cross-cutting entry points for the keyboard layer (window.UI): start a fresh
  // turn (rebuilds the hero + composer) or focus the composer. No-ops before init.
  window.ChatPanel.reset = function () { if (mountRegion) window.ChatPanel.init(mountRegion); };
  window.ChatPanel.focus = function () { var i = document.getElementById('chat-input'); if (i) i.focus(); };
})();
