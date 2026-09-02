'use strict';

/**
 * Merchant MCP core — dependency-free, unit-testable in-process.
 *
 * This module is the buyer-agent-facing surface described in
 * docs/ARCHITECTURE.md §3.5 ("the agent never sees REST directly; it calls
 * these tools"). It owns a deliberate crypto/units AIR-GAP:
 *
 *   - The LLM speaks simple JSON in RUPEES (item ids, quantities, budgets).
 *   - This layer owns ALL canonicalization, mandate signing, paise
 *     arithmetic, and failure escalation.
 *
 * Every tool is a thin wrapper over the existing merchant HTTP routes
 * (src/routes/checkout.js + the /api/v1/feed catalog). No checkout logic is
 * reimplemented here.
 *
 * It has NO npm dependencies (Node built-ins only), so tests can drive it with
 * a mock fetch — no server, no sockets. The MCP SDK wiring lives in
 * ./server.js, which imports this core.
 */

const crypto = require('crypto');
const config = require('../config');
const grants = require('../lib/delegationGrants');
const agentSignature = require('../lib/agentSignature');
const rupeesToPaise = (r) => Math.round(r * 100);

// NOTE: this module holds no signing key, by design.
//
// It used to generate its own Ed25519 buyer keypair at load and sign
// IntentMandates with it, which meant the agent authorized its own spending --
// a signature loop that proved nothing. Authority now comes from a delegation
// grant the human signed with their authenticator (src/routes/mandates.js); the
// agent only references one. If no grant exists, the agent cannot shop, and
// that is the correct failure.

// Append-only audit trail (ADR-005). Every tool execution is recorded as a
// TOOL_CALL block (inputs + outputs) on the shared hash chain, so the buyer
// agent's actions are auditable alongside the merchant's mandate/money events.
// Still no npm deps: auditLog + jcs-hmac are Node-builtin-only.
const { sharedAuditLog, EventType, Actor } = require('../lib/auditLog');

// The principal this agent acts for. Its authority is bounded by that
// principal's active grant, not by this constant.
const PRINCIPAL_ID = process.env.AGENT_PRINCIPAL_ID || 'usr_alice';

// The mandate's TTL and its category allowlist are now fixed by the human at
// grant time (src/routes/mandates.js), where the allowlist is derived from the
// storefront's real catalog rather than restated here.

// Additively annotate a session-state response with rupee companions for every
// paise-denominated field (amount, line_items[].unit_price_paise /
// line_total_paise), so the LLM always has a rupee value and never does paise
// math (air-gap). Paise fields are kept as the authoritative source — mirrors
// create_cart returning both amount_total_paise and amount_total_rupees.
function paiseToRupees(p) { return typeof p === 'number' ? p / 100 : null; }

function enrichStateWithRupees(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const out = { ...state };
  if (typeof state.amount === 'number') out.amount_in_rupees = state.amount / 100;
  if (Array.isArray(state.line_items)) {
    out.line_items = state.line_items.map((item) => {
      const lineTotalPaise = item.unit_price * item.quantity;
      return {
        ...item,
        unit_price_rupees: paiseToRupees(item.unit_price),
        line_total_rupees: paiseToRupees(lineTotalPaise),
      };
    });
  }
  return out;
}

// Build the merchant `requested_items` array from the air-gapped tool input:
// either a single item_id (+quantity) or an items[] array of {item_id, quantity}.
// Shared by create_cart and update_cart so their item semantics stay identical.
function buildRequestedItems({ item_id, quantity, items }, toolName) {
  const result = [];
  if (item_id) {
    result.push({ sku: item_id, quantity: quantity || 1 });
  }
  if (Array.isArray(items) && items.length > 0) {
    result.push(...items.map((it) => ({ sku: it.item_id || it.sku, quantity: it.quantity || 1 })));
  }
  if (result.length === 0) {
    throw new Error(`${toolName}: provide either item_id or a non-empty items[] array.`);
  }
  return result;
}

// Map a merchant create/update session response ({session_id, state,
// cart_mandate, amount_total, currency, expires_at}) to the MCP cart result,
// translating paise → rupees. If maxAmountPaise is given and the locked total
// exceeds it, attach a NON-SILENT budget_exceeded advisory — surfaced, never
// auto-retried or yielded. The terminal YIELD_TO_HUMAN signal stays reserved
// for the merchant circuit breaker so escalation semantics remain unambiguous.
function buildCartResult(body, maxAmountPaise) {
  const amountPaise = body.amount_total;
  const result = {
    session_id: body.session_id,
    state: body.state,
    amount_total_paise: amountPaise,
    amount_total_rupees: typeof amountPaise === 'number' ? amountPaise / 100 : null,
    currency: body.currency,
    expires_at: body.expires_at,
    cart_mandate_id: body.cart_mandate && body.cart_mandate.mandate_id,
  };
  if (body.cart_mandate && body.cart_mandate.claims && body.cart_mandate.claims.line_items) {
    result.line_items = body.cart_mandate.claims.line_items.map(item => ({
      ...item,
      unit_price_rupees: typeof item.unit_price_paise === 'number' ? item.unit_price_paise / 100 : (typeof item.unit_price === 'number' ? item.unit_price / 100 : null),
      line_total_rupees: typeof item.line_total_paise === 'number' ? item.line_total_paise / 100 : ((item.unit_price || item.unit_price_paise) * item.quantity / 100)
    }));
  }
  if (maxAmountPaise != null && typeof amountPaise === 'number' && amountPaise > maxAmountPaise) {
    result.budget_exceeded = {
      budget_paise: maxAmountPaise,
      amount_total_paise: amountPaise,
      over_by_paise: amountPaise - maxAmountPaise,
      advice: 'Cart total exceeds the stated budget. Adjust items/quantity or cancel; not retried automatically.',
    };
  }
  if (body.requires_approval) {
    result.requires_approval = body.requires_approval;
    result.risk_decision = body.risk_decision;
  }
  return result;
}

// ─── Tool definitions (air-gapped simple-JSON schemas) ───────────────────
//
// Note: no mandate / signature / jws fields appear in ANY inputSchema — the
// agent supplies only ids, quantities, and rupee budgets. The 5 tools named in
// docs/ARCHITECTURE.md §3.5 wrap §3.2–3.3 as specified; `update_cart` is an
// additive 6th tool exposing the PATCH /sessions/:id revise route — a deliberate
// deviation from §3.5's 5-tool surface, so the agent can revise a CREATED cart
// without cancel+recreate.
const TOOL_DEFINITIONS = [
  {
    name: 'search_catalog',
    description:
      'Search the merchant product catalog. You are searching a 10,000+ item catalog. ' +
      'If you do not find what you need, refine your search query and try again. ' +
      'At most 15 items are returned, cheapest first, so a vague query shows you the ' +
      'cheapest corner of the catalog rather than the item you want — narrow it with ' +
      'more specific keywords, a category, or a budget instead of re-running the same ' +
      'search. Filters by a required text query (matched against title and description), ' +
      'an optional category, and an optional budget_in_rupees. Prices are returned in ' +
      'rupees; the merchant prices the cart itself at checkout.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 2,
          description:
            'REQUIRED. 1-3 specific product keywords, e.g. "sony noise cancelling headphones". ' +
            'Must not be empty — an unfocused search wastes a turn on a 10,000+ item catalog. ' +
            'DO NOT include prices, "under", "10k", or filler words here; use budget_in_rupees for price.',
        },
        budget_in_rupees: { type: 'number', description: 'Optional. Per-item price ceiling in rupees; pricier products are excluded. Convert "10k" to 10000.' },
        category: { type: 'string', description: 'Optional. Category filter, e.g. "audio", "laptop", "smartphone". Narrows a large result set.' },
      },
      required: ['query'],

    },
  },
  {
    name: 'create_cart',
    description: 'Creates a new shopping cart for the current session from one or more catalog line items. Spend limits are enforced server-side against the principal\'s velocity cap (see velocityTracker.js) and are never accepted as agent-supplied input — there is no budget field on this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          minLength: 1,
          description: 'Catalog item id for a single-item cart, e.g. "prod_electronics_001".',
        },
        quantity: { type: 'integer', minimum: 1, description: 'Quantity for the single item (default 1).' },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              item_id: {
                type: 'string',
                minLength: 1,
                description: 'Catalog item id, as returned by search_products.'
              },
              quantity: {
                type: 'integer',
                minimum: 1,
                description: 'Number of units of this item to add to the cart.'
              }
            },
            required: ['item_id'],
            additionalProperties: false
          },
          description: 'Line items to add to the cart. Use instead of item_id/quantity.'
        },
        budget_in_rupees: {
          type: 'number',
          description: 'DO NOT USE. Server enforces budget automatically.'
        }
      },
    },
  },
  {
    name: 'get_cart_state',
    description:
      'Fetch the current state of a checkout session by session_id: lifecycle state, ' +
      'amount, line items, the mandate chain, and any Razorpay identifiers.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session_id returned by create_cart.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'update_cart',
    description:
      'Revise the line items of a checkout session that is still in the CREATED state ' +
      '(before completion). Replaces the current items, re-prices the cart, and re-issues ' +
      'its cart mandate. Pass session_id plus the new item(s); optionally pass ' +
      'budget_in_rupees to re-check the revised total. A session past CREATED cannot be ' +
      'updated. IMPORTANT: If you want to ADD an item to the existing cart, you MUST fetch the ' +
      'current cart with get_cart_state first, and pass BOTH the existing items and the new item in the items array.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session_id to revise (must still be in CREATED state).' },
        item_id: { type: 'string', description: 'Catalog item id for a single-item cart, e.g. "prod_electronics_001".' },
        quantity: { type: 'integer', minimum: 1, description: 'Quantity for the single item (default 1).' },
        items: {
          type: 'array',
          description: 'Multiple line items, replacing the current ones. Use instead of item_id/quantity.',
          items: {
            type: 'object',
            properties: {
              item_id: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['item_id'],
          },
        },
        budget_in_rupees: { type: 'number', description: 'Optional budget cap in rupees to re-check the revised total against.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'complete_checkout',
    description:
      'Complete a checkout session. The payment mandate is built and signed internally ' +
      'and submitted idempotently. On success returns an order id and a mandate hash for ' +
      'your records; if the amount requires human approval, returns a payment link URL to ' +
      'hand to the buyer instead of an order.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session_id to complete.' },
        idempotency_key: {
          type: 'string',
          description: 'Optional. Reuse the same key to safely retry a completion; one is generated if omitted.',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'cancel_checkout',
    description:
      'Cancel a checkout session by session_id, voiding any pending payment link. ' +
      'A session that is already paid cannot be cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session_id to cancel.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_recovery_offers',
    description:
      'Fetch any mandate-compliant recovery offers (discounts or upsells) generated for ' +
      'an expired or abandoned checkout session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session_id to check for recovery offers.' },
      },
      required: ['session_id'],
    },
  },
];

// ─── Factory ─────────────────────────────────────────────────────────────

/**
 * Build the 5 tool handlers bound to a merchant base URL, fetch impl, and
 * mandate-signing secret.
 *
 * @param {Object} [options]
 * @param {string} [options.baseUrl]  Merchant origin. Defaults to
 *   MERCHANT_BASE_URL or http://localhost:${PORT||3000}.
 * @param {Function} [options.fetchImpl]  fetch implementation. Defaults to global fetch.
 * @param {string} [options.secret]  HMAC secret for mandate proofs. Defaults to
 *   MCP_MANDATE_SECRET || RAZORPAY_KEY_SECRET || 'mcp_dummy_secret'.
 * @param {number} [options.autoApproveThresholdPaise]  Auto-approve ceiling in
 *   paise, surfaced for explainability when a completion escalates. Defaults to
 *   AUTO_APPROVE_THRESHOLD_PAISE || 1000000. The MERCHANT owns the 200-vs-202
 *   decision, so tool branching keys off the HTTP status, not this value.
 * @param {object} [options.auditLog]  Audit log to record TOOL_CALL blocks on.
 *   Defaults to the shared server-wide chain (src/lib/auditLog.sharedAuditLog);
 *   inject a fresh createAuditLog() in tests to assert tool capture in isolation.
 */
function createMerchantTools(options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : undefined);
  const baseUrl = (
    options.baseUrl ||
    process.env.MERCHANT_BASE_URL ||
    `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/+$/, '');
  const autoApproveThresholdPaise =
    options.autoApproveThresholdPaise != null
      ? options.autoApproveThresholdPaise
      : parseInt(process.env.AUTO_APPROVE_THRESHOLD_PAISE || '1000000000', 10);
  const auditLog = options.auditLog || sharedAuditLog;

  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'createMerchantTools: no fetch implementation available — pass options.fetchImpl or run on Node >= 18.'
    );
  }

  // ─── HTTP + circuit breaker ─────────────────────────────────────────────

  // Single choke point for merchant I/O. NEVER retries (req #4): the caller
  // decides. Returns { status, body } with body parsed as JSON when possible.
  // A signed call passes `canonicalBody` (the exact JCS bytes that were HMAC'd)
  // + `signature`: we transmit those bytes verbatim and set x-ap2-signature, so
  // the merchant's raw-bytes verification matches. An unsigned call serializes
  // `body` normally.
  async function callMerchant(method, path, { body, idempotencyKey } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    
    // Attestation header required by ADR-008. This asserts *which* agent is
    // acting for which principal so the audit trail names it -- it is identity,
    // not authority. The merchant binds these values to the grant and refuses a
    // mismatch; it never treats the header alone as permission to spend.
    const attestation = {
      agent_id: config.agentId,
      principal_id: PRINCIPAL_ID
    };
    headers['X-Agorio-Attestation'] = Buffer.from(JSON.stringify(attestation)).toString('base64');

    // Sign the request with the agent's Ed25519 private key (the server verifies
    // with AGENT_PUBLIC_KEY). The signed payload binds method, path, attested
    // agent + principal, timestamp, nonce, and body — see src/lib/agentSignature.js.
    // resolveAgentPrivateKey() sources the key: configured AGENT_PRIVATE_KEY in
    // production, or a zero-config dev pair when the client runs standalone (e.g.
    // unit tests that drive this module without booting the server).
    headers['X-Agorio-Signature'] = agentSignature.signRequest({
      method,
      path,
      agentId: attestation.agent_id,
      principalId: attestation.principal_id,
      body,
      privateKey: agentSignature.resolveAgentPrivateKey(),
    });
    
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const init = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetchImpl(baseUrl + path, init);
    const status = res.status;
    let parsed = null;
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status, body: parsed };
  }

  // The circuit breaker (req #4). No silent retries anywhere:
  //   - 2xx (incl. 202 escalation) → pass through.
  //   - 4xx with retriable === false → UNRECOVERABLE: throw the YIELD_TO_HUMAN
  //     signal so the LLM stops and escalates to a person.
  //   - everything else (retriable-true 4xx, 5xx) → a plain descriptive error;
  //     still no auto-retry, but not the terminal YIELD signal.
  function throwIfUnrecoverable(status, body) {
    if (status >= 200 && status < 300) return;
    const err = body && typeof body === 'object' ? body.error : null;
    
    const code = (err && err.code) || `HTTP_${status}`;
    const message = (err && err.message) || `Merchant returned status ${status}`;
    const retriable = err && err.retriable === true;

    const formattedError = JSON.stringify({
      status,
      code,
      message,
      retriable
    }, null, 2);

    if (status >= 400 && status < 500 && err && err.retriable === false) {
      throw new Error(
        'YIELD_TO_HUMAN: Unrecoverable checkout state.\n' + formattedError
      );
    }
    throw new Error(`Merchant error ${status} ${code}: ${message}\n` + formattedError);
  }

  let searchCount = 0;
  
  // ─── Tool: search_catalog ───────────────────────────────────────────────
  async function search_catalog(input = {}) {
    searchCount++;
    if (searchCount > 2) {
      throw new Error(
        'search_catalog loop detected: you have called this tool more than 2 times. ' +
        'Stop searching, analyze the results you already have, and ask the user for clarification or proceed with checkout.'
      );
    }
    
    const { query, budget_in_rupees, category } = input;
    // A blank search against a 10,000+ item catalog is not a search — it is a
    // request for an arbitrary 15 rows. Fail here, before the HTTP call, with
    // the instruction the agent needs to recover on its next turn.
    if (typeof query !== 'string' || query.trim().length < 2) {
      throw new Error(
        'search_catalog: `query` is required and must be at least 2 characters. ' +
        'You are searching a 10,000+ item catalog — supply specific product keywords ' +
        '(e.g. "noise cancelling headphones"), optionally narrowed by category or budget_in_rupees.'
      );
    }
    const budgetPaise = typeof budget_in_rupees === 'number' ? rupeesToPaise(budget_in_rupees) : null;

    const params = new URLSearchParams();
    params.append('query', query.trim());
    if (budgetPaise !== null) params.append('max_price', budgetPaise);
    if (category) params.append('category', category);

    const path = '/api/v1/products?' + params.toString();
    const { status, body } = await callMerchant('GET', path);
    throwIfUnrecoverable(status, body);

    const products = body && Array.isArray(body.products) ? body.products : [];

    // The route already returns the narrow, rupee-denominated shape
    // { sku, name, price_inr, stock }. Rename sku -> item_id for the tool
    // surface (create_cart/update_cart take item_id) and pass the rest through
    // — no paise arithmetic happens on this side of the air gap any more,
    // because the merchant no longer sends paise here.
    const results = products.map((p) => ({
      item_id: p.sku,
      title: p.name,
      price_in_rupees: p.price_inr,
      stock: p.stock,
    }));

    const out = { products: results, count: results.length };
    if (results.length === 0) {
      out.advice =
        'No matches. Refine the query with different or broader keywords, or relax ' +
        'category / budget_in_rupees — do not re-run this exact search.';
    } else if (results.length >= 15) {
      // The route caps at 15, so a full page means the catalog almost certainly
      // holds more. Say so, rather than letting the agent read a truncated page
      // as the complete answer.
      out.truncated = true;
      out.advice =
        'Showing the 15 cheapest matches; more exist. Add keywords, a category, or a ' +
        'budget_in_rupees to narrow the search before choosing.';
    }
    return out;
  }

  // ─── Tool: create_cart ──────────────────────────────────────────────────
  async function create_cart(input = {}) {
    if ('budget_in_rupees' in input) {
      auditLog.append({
        session_id: null,
        actor: Actor.BUYER_AGENT,
        event_type: EventType.TOOL_CALL, // Actually, log IGNORED_AGENT_SUPPLIED_LIMIT
        payload: { note: 'IGNORED_AGENT_SUPPLIED_LIMIT', supplied: input.budget_in_rupees }
      });
      delete input.budget_in_rupees;
    }

    // The agent shops under authority the human signed, and cannot create that
    // authority for itself. With no active grant there is nothing to act under,
    // so the tool stops and asks for a person -- it does not fall back to a
    // self-issued mandate.
    const grant = grants.activeGrantFor(PRINCIPAL_ID);
    if (!grant) {
      throw new Error(
        'YIELD_TO_HUMAN: No active delegation grant.\n' +
        JSON.stringify({
          code: 'DELEGATION_GRANT_REQUIRED',
          message: `${PRINCIPAL_ID} has not authorized this agent to spend. The human must approve a delegation grant with their passkey (POST /api/v1/mandates/intent) before checkout can proceed.`,
          retriable: false,
        }, null, 2)
      );
    }

    const maxAmountPaise = grant.max_amount_paise;
    const requested_items = buildRequestedItems(input, 'create_cart');

    // Reference the grant; the merchant loads the human-signed envelope itself.
    // Nothing the agent sends here can widen what the human authorized.
    const { status, body } = await callMerchant('POST', '/api/v1/checkout/sessions', {
      body: { intent_mandate_id: grant.mandate_id, requested_items }
    });
    throwIfUnrecoverable(status, body);

    return buildCartResult(body, maxAmountPaise);
  }

  // ─── Tool: update_cart ──────────────────────────────────────────────────
  async function update_cart(input = {}) {
    const { session_id, budget_in_rupees } = input;
    if (!session_id) throw new Error('update_cart: session_id is required.');
    const requested_items = buildRequestedItems(input, 'update_cart');

    const { status, body } = await callMerchant(
      'PATCH',
      `/api/v1/checkout/sessions/${encodeURIComponent(session_id)}`,
      { body: { requested_items } }
    );
    throwIfUnrecoverable(status, body);

    const maxAmountPaise = typeof budget_in_rupees === 'number' ? rupeesToPaise(budget_in_rupees) : null;
    return buildCartResult(body, maxAmountPaise);
  }

  // ─── Tool: get_cart_state ───────────────────────────────────────────────
  async function get_cart_state(input = {}) {
    const { session_id } = input;
    if (!session_id) throw new Error('get_cart_state: session_id is required.');
    const { status, body } = await callMerchant(
      'GET',
      `/api/v1/checkout/sessions/${encodeURIComponent(session_id)}`
    );
    throwIfUnrecoverable(status, body);
    
    if (!body.line_items && body.cart_mandate && body.cart_mandate.claims && body.cart_mandate.claims.line_items) {
      body.line_items = body.cart_mandate.claims.line_items;
    }
    
    // The merchant reports amounts in paise; enrich with rupee companions so the
    // LLM stays air-gapped from paise arithmetic (consistent with search_catalog
    // and create_cart, which already surface rupee-denominated values).
    return enrichStateWithRupees(body);
  }

  // ─── Tool: complete_checkout ────────────────────────────────────────────
  async function complete_checkout(input = {}) {
    const { session_id } = input;
    if (!session_id) throw new Error('complete_checkout: session_id is required.');
    const idempotencyKey = input.idempotency_key || 'idem_' + crypto.randomBytes(12).toString('hex');

    // Send empty POST body, let merchant server mint the PaymentMandate.
    const { status, body } = await callMerchant(
      'POST',
      `/api/v1/checkout/sessions/${encodeURIComponent(session_id)}/complete`,
      { idempotencyKey, body: {} }
    );
    throwIfUnrecoverable(status, body);

    const out = {
      session_id: body.session_id,
      state: body.state,
      payment_mandate_id: body.payment_mandate_id,
      idempotency_key: idempotencyKey,
      next: body.next,
    };

    // 200 path: a real order was created.
    if (body.order) {
      out.order_id = body.order.order_id;
      out.razorpay_order_id = body.order.razorpay_order_id;
    }
    // 202 path: escalated to human approval — surface the link, not an order
    // (req #5 explainability), plus WHY it escalated.
    if (body.approval) {
      out.approval_type = body.approval.type;
      out.payment_link_url = body.approval.url;
      out.payment_link_id = body.approval.payment_link_id;
      out.auto_approve_threshold_paise = autoApproveThresholdPaise;
    }

    return out;
  }

  // ─── Tool: cancel_checkout ──────────────────────────────────────────────
  async function cancel_checkout(input = {}) {
    const { session_id } = input;
    if (!session_id) throw new Error('cancel_checkout: session_id is required.');
    const { status, body } = await callMerchant(
      'POST',
      `/api/v1/checkout/sessions/${encodeURIComponent(session_id)}/cancel`
    );
    throwIfUnrecoverable(status, body);
    return body;
  }

  // ─── Tool: get_recovery_offers ──────────────────────────────────────────
  async function get_recovery_offers(input = {}) {
    const { session_id } = input;
    if (!session_id) throw new Error('get_recovery_offers: session_id is required.');
    const { status, body } = await callMerchant(
      'GET',
      `/api/v1/checkout/sessions/${encodeURIComponent(session_id)}/recovery_offers`
    );
    throwIfUnrecoverable(status, body);
    
    // Add rupee companions to the paise fields
    if (body.offers && Array.isArray(body.offers)) {
      body.offers = body.offers.map(offer => ({
        ...offer,
        discount_rupees: offer.discount_paise / 100,
        final_price_rupees: offer.final_price_paise / 100
      }));
    }
    
    return body;
  }

  // ─── Audit tap (ADR-005) ────────────────────────────────────────────────
  // Wrap every tool so each execution appends exactly one TOOL_CALL block —
  // capturing the tool name, the agent's inputs, and the tool's output (or the
  // error message when it throws) — then returns/re-throws the result unchanged.
  // The audit append never alters or masks a tool's result or its failure.
  function withAudit(toolName, handler) {
    return async (input = {}) => {
      try {
        const output = await handler(input);
        auditLog.append({
          session_id: (input && input.session_id) || (output && output.session_id) || null,
          actor: Actor.BUYER_AGENT,
          event_type: EventType.TOOL_CALL,
          payload: { tool: toolName, input, output },
        });
        return output;
      } catch (err) {
        auditLog.append({
          session_id: (input && input.session_id) || null,
          actor: Actor.BUYER_AGENT,
          event_type: EventType.TOOL_CALL,
          payload: { tool: toolName, input, error: (err && err.message) || String(err) },
        });
        throw err;
      }
    };
  }

  return {
    search_catalog: withAudit('search_catalog', search_catalog),
    create_cart: withAudit('create_cart', create_cart),
    update_cart: withAudit('update_cart', update_cart),
    get_cart_state: withAudit('get_cart_state', get_cart_state),
    complete_checkout: withAudit('complete_checkout', complete_checkout),
    cancel_checkout: withAudit('cancel_checkout', cancel_checkout),
    get_recovery_offers: withAudit('get_recovery_offers', get_recovery_offers),
  };
}

module.exports = {
  TOOL_DEFINITIONS,
  createMerchantTools,
};
