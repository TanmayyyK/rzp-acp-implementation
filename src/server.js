'use strict';

/**
 * server.js — composition root for the Agentic Commerce Platform.
 *
 * Architecture (see docs/ARCHITECTURE.md):
 *   - Webhook route MUST come before express.json() so the raw body
 *     is preserved as a Buffer for HMAC-SHA256 verification.
 *   - All other routes use express.json() normally.
 *   - The app is exported without calling listen() so tests can
 *     drive it in-process.
 */

const express = require('express');
const path = require('path');
const config = require('./config');
const { generateEd25519KeyPair } = require('./lib/jcs-eddsa');
const agentSignature = require('./lib/agentSignature');

// Initialize merchant keypair. The merchant legitimately signs its own
// artifacts (CartMandate, PaymentMandate) as processor-of-record, so this key
// belongs to the server. Buyer and human authority deliberately do NOT: those
// are rooted in WebAuthn credentials the server can verify but never wield
// (see src/circle/humanAuthorization.js).
if (!process.env.MERCHANT_PRIVATE_KEY || !process.env.MERCHANT_PUBLIC_KEY) {
  console.warn('[WARN] Ephemeral merchant keypair generated. This is unsafe for production as pending CartMandates will invalidate on restart. Set MERCHANT_PRIVATE_KEY and MERCHANT_PUBLIC_KEY in your environment.');
  const merchantKeypair = generateEd25519KeyPair();
  process.env.MERCHANT_PRIVATE_KEY = merchantKeypair.privateKey;
  process.env.MERCHANT_PUBLIC_KEY = merchantKeypair.publicKey;
}

// Agent identity is asymmetric (this retired the shared AGENT_SECRET HMAC): the
// agent holds AGENT_PRIVATE_KEY and signs its requests; the server holds only
// AGENT_PUBLIC_KEY and verifies (src/lib/agentSignature.js). In a real deployment
// the private key lives with the agent process and the server is configured with
// the public key alone — so if AGENT_PUBLIC_KEY is already set, we never mint a
// private key here. For zero-config dev and the in-process test suite (where the
// agent client runs in this same process), generate a pair when neither is set.
// The provisioning guard lives in agentSignature so it stays in lockstep with the
// signer's resolveAgentPrivateKey().
agentSignature.ensureDevKeypair();

// The AI SDK (`ai`, `@ai-sdk/*`) is ESM-only and is needed ONLY on the live-LLM
// chat path, so it is required lazily in getAiRuntime() below — never at module
// load. That keeps server boot light and, critically, lets every in-process test
// load this app: Jest's CommonJS loader cannot parse the ESM bundle, and the
// stub/default path never touches it. The MCP merchant tools are plain
// CommonJS, so they stay top-level.
const { createMerchantTools, TOOL_DEFINITIONS } = require('./mcp/merchantClient');
// The one server-wide, hash-chained audit trail (ADR-005). Seeded with a GENESIS
// block at module load (server boot). Server-side taps append here: mandate
// verifications (below) and money actions (checkout.js / orders.js). GET
// /audit-log serves the whole chain plus its integrity proof.
const { sharedAuditLog: auditLog, EventType, Actor, GENESIS_PREV_HASH } = require('./lib/auditLog');

// Route modules
const webhookRouter = require('./routes/webhooks');
const ordersRouter = require('./routes/orders');
const checkoutRouter = require('./routes/checkout');
const productsRouter = require('./routes/products');
const authRouter = require('./routes/auth');
const userRouter = require('./routes/user');
// Where an agent's spending authority is created: the human signs an
// IntentMandate with their own authenticator (ADR-008).
const mandatesRouter = require('./routes/mandates');
const ledgerRouter = require('./routes/ledger');
const session = require('express-session');
const { SqliteSessionStore } = require('./lib/sqliteSessionStore');

const app = express();

// ==========================================
// 0. CORS & Cross-Origin support (for Next.js frontend on port 3001)
// ==========================================
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Idempotency-Key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ==========================================
// 1. ACP Discovery Endpoint (no body parsing needed)
// ==========================================
app.get('/.well-known/acp.json', (_req, res) => {
  res.json({
    version: '2.0',
    name: 'Agentic Commerce Node',
    description: 'ACP-shaped checkout + AP2-shaped mandates on Razorpay test-mode rails',
    capabilities: ['search', 'recommend', 'compare', 'negotiate', 'transact'],
    endpoints: {
      products: '/api/v1/products',
      checkout_sessions: '/api/v1/checkout/sessions',
      webhooks: '/api/v1/webhooks/razorpay',
    },
    checkout_lifecycle: ['CREATED', 'CONFIRMED', 'PAID', 'FULFILLING', 'COMPLETED'],
    supported_currencies: ['INR'],
    supported_protocols: ['ACP-2.0', 'AP2'],
  });
});

// ==========================================
// 2. Webhook route — raw body, BEFORE express.json()
// ==========================================
app.use('/api/v1/webhooks/razorpay', express.raw({ type: 'application/json' }), webhookRouter);

// ==========================================
// 4. JSON body parser for everything else
// ==========================================
app.use(express.json());

app.use(session({
  secret: config.sessionSecret,
  store: new SqliteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.isProduction,
    httpOnly: true,
    sameSite: 'lax',
  }
}));

// ==========================================
// 4. Application routes
// ==========================================
app.use('/auth', authRouter);
app.use('/user', userRouter);
app.use('/x402', require('./routes/x402'));
app.use('/api/v1/products', productsRouter);
// app.use feed removed
// app.use feed removed
app.use('/api/v1/mandates', mandatesRouter);
app.use('/api/v1/ledger', ledgerRouter);
app.use('/api/v1/orders', ordersRouter);
app.use('/api/v1/checkout', checkoutRouter);
app.use('/session', (req, res, next) => {
  if (req.url === '/' || req.url === '') {
    req.url = '/sessions';
  } else {
    req.url = '/sessions' + req.url;
  }
  checkoutRouter(req, res, next);
});


// ==========================================
// 5. Health check
// ==========================================
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// 6. Audit log — the whole hash chain, for the UI (ADR-005)
//    A plain GET, so it falls through the mandate-signature guard unsigned.
//    Returns every block in order, plus the genesis anchor and a live
//    verifyChain() integrity result so the UI can prove the log is untampered.
// ==========================================
app.get('/audit-log', (req, res) => {
  const isAdmin = req.headers['authorization'] === `Bearer ${process.env.ADMIN_SECRET || 'admin_secret'}`;
  const entries = auditLog.entries();

  let returnedEntries = entries;
  if (!isAdmin) {
    returnedEntries = entries.map(entry => {
      // Deep clone payload to redact
      const payloadStr = JSON.stringify(entry.payload || {});
      const redactedStr = payloadStr
        .replace(/"(session_id|intent_mandate_id|credential_id|mandate_id|order_id|razorpay_order_id|receipt|payment_id|payment_link_id|agent_id|principal_id)":"[^"]+"/g, '"$1":"[REDACTED]"');
      return { ...entry, payload: JSON.parse(redactedStr) };
    });
  }

  res.json({
    genesis_hash: GENESIS_PREV_HASH,
    count: entries.length,
    integrity: auditLog.verifyChain(),
    entries: returnedEntries,
  });
});

// ==========================================
// 7. Dashboard and Frontend Assets
// ==========================================
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.post('/audit-log/verify', (req, res) => {
  try {
    const verification = auditLog.verifyChain();
    return res.status(200).json(verification);
  } catch (err) {
    return res.status(500).json({ error: err.message, valid: false });
  }
});

// ==========================================
// 8. Buyer-agent chat — drives the left panel of the dashboard.
//
// This is an in-process demo agent (no LLM, no sockets — the sandbox blocks
// both): it classifies the message and, for a purchase, mints a stub order.
// Crucially it is WIRED to the same shared audit chain the HashChain panel
// polls, so a purchase on the left surfaces as real, hash-linked blocks on the
// right (AGENT_REASONING → MONEY_ACTION, or → GUARDRAIL_DECISION on escalation).
// The receipt's `refId` IS the money block's hash, so the "chain …" shown on
// the receipt matches the block the panel renders.
//
// Response is the array of view-model messages chat.js renders: agent/user
// bubbles read `content`; receipts read numeric `data.*` and format client-side
// (rupees via Intl, time via Date) — the server sends data, not presentation.
// ==========================================
const PURCHASE_INTENT_RE = /\b(buy|order|purchase|get me|checkout|book)\b/i;
// Auto-approve ceiling, shared system-wide with the MCP layer (paise → rupees).
const AUTO_APPROVE_RUPEES =
  parseInt(process.env.AUTO_APPROVE_THRESHOLD_PAISE || '1000000000', 10) / 100;


const merchantTools = createMerchantTools(); // Uses sharedAuditLog natively via import inside merchantClient

// Lazily load the ESM-only AI SDK and build the tool set once, on first live-LLM
// use (cached thereafter). Kept out of module scope so `require('../src/server')`
// in tests never pulls the ESM bundle into Jest's CommonJS require graph.
let _aiRuntime = null;
function getAiRuntime() {
  if (_aiRuntime) return _aiRuntime;
  const { generateText, streamText, tool, isStepCount, jsonSchema } = require('ai');
  
  const { google } = require('@ai-sdk/google');
  const { groq, createGroq } = require('@ai-sdk/groq');
  const aiTools = {};
  for (const def of TOOL_DEFINITIONS) {
    aiTools[def.name] = tool({
      description: def.description,
      // AI SDK v7 reads `inputSchema` (v4's `parameters` is ignored — that left
      // every tool with an empty schema, so the model guessed args from the
      // description and Groq rejected them as unknown properties).
      inputSchema: jsonSchema(def.inputSchema),
      execute: async (args) => await merchantTools[def.name](args),
    });
  }
  // A SECOND, dedicated Groq provider keyed by GROQ_API_KEY_2, used ONLY by the
  // streamed live-thinking narration (/chat/thinking). Isolating it on its own
  // key means the real-time reasoning feed never competes for — or gets rate-
  // limited by — the money-moving agent's GROQ_API_KEY, so it stays fast. Falls
  // back to the primary key if the dedicated one isn't set.
  const groqThinking = createGroq({
    apiKey: process.env.GROQ_API_KEY_2 || process.env.GROQ_API_KEY,
  });
  _aiRuntime = { generateText, streamText, google, groq, groqThinking, aiTools, isStepCount };
  return _aiRuntime;
}

// The live-thinking model. A short, streamed narration, so speed matters more
// than tool skill — default to Groq's fastest served model.
const THINKING_MODEL = process.env.GROQ_THINKING_MODEL || 'qwen/qwen3.6-27b';
// If the dedicated Groq narration model can't be reached (bad id, rate limit, or
// a dropped GROQ_API_KEY_2), the live bar falls back to the SAME Gemini model the
// money-moving /chat already uses successfully — so the reasoning still streams
// instead of silently dropping. This mirrors /chat's primary→fallback resilience,
// which the thinking endpoint previously lacked (its only failure mode was an
// empty bar).
const THINKING_FALLBACK_MODEL = process.env.THINKING_FALLBACK_MODEL || 'gemini-3.6-flash';
const THINKING_SYSTEM =
  'You are the inner monologue of an autonomous shopping agent, thinking OUT LOUD in real time ' +
  'as you work. Speak in the first person, present tense ("I\'m searching the catalog…", ' +
  '"Now I\'m building the cart…"). Your real tools, in order, are: search the catalog, build a ' +
  'cart within the budget, run a spend guardrail, then complete checkout on Razorpay. Narrate ' +
  'those concrete steps for THIS request in 3–5 very short lines. Always speak in Indian Rupees (₹). ' +
  'No markdown, no headings, no bullets, no code, no preamble and no sign-off — only the live narration.';

const BUYER_AGENT_SYSTEM =
  'You are the autonomous AI Buyer Agent. Your job is to fulfill natural language ' +
  'shopping requests using the connected MCP tools. You MUST speak in RUPEES. The ' +
  'MCP tools handle all conversions to paise. If a merchant route returns a ' +
  'YIELD_TO_HUMAN error, you MUST stop and escalate to the human user immediately ' +
  'without retrying silently. When the user asks to buy something, use search_catalog ' +
  'to find it, then use create_cart, and finally complete_checkout. CRITICAL INSTRUCTION: Never call search_catalog multiple times for the same request. You must only search ONCE, then immediately reply to the user with the results you found.';

// ==========================================
// 8a. Live "thinking" narration — streamed, real-time.
//
// The /chat endpoint below is non-streaming: it runs the whole tool loop and
// only responds once the turn is fully settled, so on its own the UI can show
// the agent's reasoning only AFTER the fact — out of temporal order with the
// work (the "time-correlation" problem). This endpoint fixes that: fired by the
// client in parallel with /chat the instant the user hits send, it streams a
// concise first-person narration of the steps the agent is taking, token by
// token, straight into the chat's clickable "thinking" bar. It is powered by a
// SECOND Groq key (GROQ_API_KEY_2) so the fast narration never contends with the
// money-moving agent's rate limit. It touches no money and appends no audit
// blocks — it is a view concern only. On any failure it just closes the stream
// and the client keeps its static placeholder.
// ==========================================
app.post('/chat/thinking', async (req, res) => {
  const { message, messages, budget } = req.body || {};
  let text = '';
  if (Array.isArray(messages) && messages.length > 0) {
    text = String(messages[messages.length - 1].content || '').trim();
  } else if (typeof message === 'string') {
    text = message.trim();
  }
  const budgetRupees = Number.isFinite(budget) && budget > 0 ? budget : AUTO_APPROVE_RUPEES;

  // Chunked plain-text stream — no proxy buffering, flush deltas as they arrive.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  if (!text || !(process.env.GROQ_API_KEY_2 || process.env.GROQ_API_KEY)) {
    return res.end(); // nothing to narrate / no key → client falls back gracefully
  }

  let aborted = false;
  req.on('close', () => { aborted = true; }); // client finalized the bar first

  const { streamText, google, groqThinking } = getAiRuntime();
  const prompt =
    `The shopper said: "${text}"\n` +
    `Their spend budget for this purchase is ₹${budgetRupees}.\n` +
    `Narrate, right now, the concrete steps you are taking to fulfil this.`;

  // Stream one model's narration into the response and report how many characters
  // it emitted, so the caller can decide whether the fallback is needed. A
  // provider/model error (bad id, rate limit, dropped socket) must never escape as
  // an unhandled rejection — that could crash the process mid-turn and break the
  // concurrent /chat, leaving the UI wedged. So every failure is swallowed here
  // and simply reported as "0 characters written".
  async function pumpThinking(model) {
    let wrote = 0;
    try {
      const result = streamText({
        model,
        system: THINKING_SYSTEM,
        prompt,
        temperature: 0.4,
        maxOutputTokens: 220, // keep it short so it stays snappy
        onError: (ev) => {
          const e = ev && ev.error ? ev.error : ev;
          console.error('thinking-stream model error:', (e && e.message) || e);
        },
      });
      for await (const delta of result.textStream) {
        if (aborted) break;
        if (delta) { res.write(delta); wrote += delta.length; }
      }
    } catch (err) {
      console.error('thinking-stream error:', err && err.message);
    }
    return wrote;
  }

  try {
    // Fast path: the dedicated Groq narration model (GROQ_API_KEY_2). If it emits
    // nothing before the turn settles, fall back to Gemini so the bar still
    // streams. We only fall back when NOT aborted — an abort means the money-moving
    // /chat already finished and the client has closed the bar, so there is nothing
    // left to narrate.
    const wrote = await pumpThinking(groqThinking(THINKING_MODEL));
    if (wrote === 0 && !aborted) {
      await pumpThinking(google(THINKING_FALLBACK_MODEL));
    }
  } finally {
    if (!aborted) { try { res.end(); } catch { /* already closed */ } }
  }
});

app.post('/chat', async (req, res) => {
  const { message, messages, provider } = req.body || {};
  let conversation = [];
  let text = '';
  
  if (Array.isArray(messages) && messages.length > 0) {
    conversation = messages
      .filter(m => m.role === 'user' || m.role === 'agent' || m.role === 'assistant')
      .map(m => ({ role: m.role === 'agent' ? 'assistant' : m.role, content: m.content || '' }));
    text = conversation[conversation.length - 1].content.trim();
  } else if (typeof message === 'string') {
    text = message.trim();
    conversation = [{ role: 'user', content: text }];
  }
  // A UI budget is context for the live agent, never authority. Authority is
  // created only by the signed-delegation flow in guarded checkout.

  // Record reasoning
  auditLog.append({
    session_id: null,
    actor: Actor.BUYER_AGENT,
    event_type: EventType.AGENT_REASONING,
    payload: { provider: provider || 'stub', user_message: text, intent: 'chat' },
  });

  if (provider === 'stub' || !provider) {
    return res.json([{
      role: 'agent',
      content: PURCHASE_INTENT_RE.test(text)
        ? 'Purchase simulation is disabled. Select a live provider and complete the signed delegation flow; no order, payment, receipt, or money audit event was created.'
        : 'Safe preview mode is active. Select a live provider to search the catalog or begin an authorized checkout.',
      timestamp: Date.now(),
    }]);
  }

  // Live LLM Path — pull the ESM AI SDK in now (first use), not at boot.
  const { generateText, google, groq, aiTools, isStepCount } = getAiRuntime();
  const modelGoogle = google('gemini-3.6-flash');
  const modelGroq = groq('qwen/qwen3.6-27b'); // real Groq Qwen3 id

  let primaryModel = provider === 'gemini' ? modelGoogle : modelGroq;
  let fallbackModel = provider === 'gemini' ? modelGroq : modelGoogle;
  let badge = provider === 'gemini' ? '[⚡ Gemini]' : '[🧠 Groq]';
  let fallbackBadge = provider === 'gemini' ? '[🧠 Groq]' : '[⚡ Gemini]';

  // Give the live agent the user's allocated budget so its create_cart builds the
  // IntentMandate with max_paise = this ceiling — which checkout.js:315 already logs
  // as MANDATE_ISSUED. Without it the agent invents an amount and the cap shown in
  // the Inspector wouldn't be the user's number.

  // One request shape for both the primary attempt and the rate-limit fallback,
  // so they can never drift. `tools` now carries real JSON input schemas (see
  // getAiRuntime); without them the model guessed argument names from the tool
  // descriptions and Groq rejected the call as unknown properties.
  const requestOptions = {
    system: BUYER_AGENT_SYSTEM,
    messages: conversation, // Use the full conversation history
    tools: aiTools,
    stopWhen: isStepCount(5),
  };

  let result;
  let usedFallback = false;

  try {
    result = await generateText({ model: primaryModel, ...requestOptions });
  } catch (err) {
    console.error(`Error with primary model ${provider}:`, err.message);
    const msg = err.message || '';
    const isRateLimitOrServerError = msg.includes('429') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504');
    if (isRateLimitOrServerError) {
      usedFallback = true;
      try {
        result = await generateText({ model: fallbackModel, ...requestOptions });
      } catch (fallbackErr) {
        console.error('Error with fallback model:', fallbackErr.message);
        return res.json([{ role: 'agent', content: `${badge} Error generating response: ${err.message}`, timestamp: Date.now() }]);
      }
    } else {
      return res.json([{ role: 'agent', content: `${badge} Error generating response: ${err.message}`, timestamp: Date.now() }]);
    }
  }

  let rawText = result.text || 'I have completed the task.';

  // Strip any <think>…</think> monologue the model emits inline so raw reasoning
  // tokens never leak into the visible answer. The agent's reasoning is surfaced
  // live in the chat's "thinking" bar instead — streamed from the shared audit
  // chain (AGENT_REASONING + TOOL_CALL blocks) as the turn runs — so no
  // "Show thinking" disclosure is appended to the response here.
  rawText = rawText.replace(/<think>[\s\S]*?<\/think>/i, '').trim();

  let finalContent = `${usedFallback ? fallbackBadge : badge} ${rawText}`;
  if (usedFallback) {
    finalContent += `\n\n(Rate limit hit. Auto-recovered using ${provider === 'gemini' ? 'Groq' : 'Gemini'}.)`;
  }

  // Synthesize a receipt from the tools the agent actually ran. AI SDK v7 exposes
  // each tool result as { toolName, input, output } — v4's { args, result } names
  // are undefined here, and reading them is why the live receipt never rendered
  // even when the model completed checkout. The cart carries the authoritative
  // amount; the checkout carries the final status and order id, so we read the
  // amount from create_cart and the status/id from complete_checkout.
  let cartOutput = null;
  let cartInput = null;
  let checkoutOutput = null;
  if (Array.isArray(result.steps)) {
    for (const step of result.steps) {
      const toolResults = step.toolResults || [];
      for (const tr of toolResults) {
        if (!tr.output) continue;
        if (tr.toolName === 'create_cart' || tr.toolName === 'update_cart' || tr.toolName === 'get_cart_state') {
          cartOutput = tr.output;
          cartInput = tr.input || null;
        } else if (tr.toolName === 'complete_checkout') {
          checkoutOutput = tr.output;
        }
      }
    }
  }

  let receiptMsg = null;
  if (cartOutput || checkoutOutput) {
    // Amount: the cart's total is authoritative; complete_checkout doesn't restate it.
    const amt = (cartOutput && cartOutput.amount_total_rupees) || 0;
    const taxAmt = Math.round(amt * 0.18);
    const subAmt = amt - taxAmt;

    // A Razorpay order/payment link is a pending collection artifact, not a
    // settled payment. Only a verified webhook may represent PAID state.
    let status = 'pending_payment';
    if (checkoutOutput) {
      if (checkoutOutput.order_id || checkoutOutput.razorpay_order_id) status = 'confirmed';
      else if (checkoutOutput.payment_link_url || checkoutOutput.state === 'yield_to_human') status = 'pending_approval';
    } else if (cartOutput && (cartOutput.budget_exceeded || cartOutput.requires_approval)) {
      status = 'pending_approval';
    }

    const sId =
      (checkoutOutput && (checkoutOutput.session_id || checkoutOutput.order_id || checkoutOutput.razorpay_order_id)) ||
      (cartOutput && cartOutput.session_id) ||
      'ORD-UNKNOWN';
    const itemName = (cartInput && (cartInput.item_id || cartInput.query)) || 'Requested items';
    
    let renderedItems = [];
    if (cartOutput && Array.isArray(cartOutput.line_items) && cartOutput.line_items.length > 0) {
      renderedItems = cartOutput.line_items.map(li => ({
        name: li.title || li.name || li.sku || 'Item',
        price: li.line_total_rupees !== undefined ? li.line_total_rupees : (li.unit_price_rupees || subAmt),
        quantity: li.quantity
      }));
    } else {
      renderedItems = [{ name: itemName, price: subAmt }];
    }

    // Link the receipt to the real audit block for this session (the checkout /
    // orders taps append MONEY_ACTION on the shared chain), so the "chain …" on the
    // receipt matches a block the Inspector renders.
    const entries = auditLog.entries();
    let blockHash = sId;
    for (let i = entries.length - 1; i >= 0; i--) {
      const b = entries[i];
      const bp = b.payload || {};
      if (bp.session_id === sId || bp.razorpay_order_id === sId || bp.order_id === sId || (bp.data && bp.data.id === sId)) {
        blockHash = b.hash;
        break;
      }
    }

    receiptMsg = {
      role: 'receipt',
      timestamp: Date.now(),
      data: {
        status,
        merchantName: 'Marketplace via AP2',
        orderId: sId,
        items: renderedItems,
        subtotal: subAmt,
        tax: taxAmt,
        total: amt,
        refId: blockHash,
        timestamp: Date.now(),
      },
    };
  }

  const responseMessages = [{
    role: 'agent',
    content: finalContent,
    timestamp: Date.now(),
  }];

  if (receiptMsg) responseMessages.push(receiptMsg);

  res.json(responseMessages);
});


// ==========================================
// Start server only when run directly
// ==========================================
if (require.main === module) {
  const port = config.port;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Agentic Commerce Platform listening on port ${port}`);
    console.log(`ACP Discovery:      http://localhost:${port}/.well-known/acp.json`);
    console.log(`Webhooks:           http://localhost:${port}/api/v1/webhooks/razorpay`);
    console.log(`Products:           http://localhost:${port}/api/v1/products`);
    console.log(`Feed:               http://localhost:${port}/feed`);
    console.log(`Orders:             http://localhost:${port}/api/v1/orders`);
    console.log(`Checkout:           http://localhost:${port}/api/v1/checkout/sessions`);
    console.log(`Session alias:      http://localhost:${port}/session`);
  });
}

module.exports = app;
