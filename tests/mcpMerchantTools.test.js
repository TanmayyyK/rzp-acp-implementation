'use strict';

/**
 * MCP merchant tools — in-process unit tests.
 *
 * These never bind a port or import the MCP SDK: they drive the dependency-free
 * core (src/mcp/merchantClient.js) with an injected mock fetch, so they run in
 * this sandbox. They prove the four air-gap guarantees:
 *   (a) rupees → paise (*100) crosses the boundary in both search and create;
 *   (b) the PaymentMandate is transport-signed with RFC 8785 (JCS)
 *       canonicalization + HMAC-SHA256: the canonical bytes go on the wire as
 *       the request body and the hex digest as the x-ap2-signature header, and
 *       that digest verifies over those exact bytes (mirroring the merchant's
 *       verifySignature middleware — the same jcs-hmac module both sides share);
 *   (c) 4xx + retriable:false trips the YIELD_TO_HUMAN circuit breaker;
 *   (d) 4xx + retriable:true does NOT trip it (no false escalation);
 *   (e) complete_checkout surfaces order_id + mandate_hash for explainability.
 */

// The tool core acts under a delegation grant a human signed — it cannot mint
// authority for itself. Give this suite its own principal (read at module load)
// so the grant seeded below cannot collide with another suite's grants in the
// shared SQLite file.
const GRANT_PRINCIPAL = 'usr_mcp_tools_test';
process.env.AGENT_PRINCIPAL_ID = GRANT_PRINCIPAL;

const { TOOL_DEFINITIONS, createMerchantTools } = require('../src/mcp/merchantClient');
const db = require('../src/db');
// A fresh, isolated hash chain per test — injected via options.auditLog so tool
// captures are asserted without touching the process-wide shared chain.
const { createAuditLog } = require('../src/lib/auditLog');
// The buyer client (merchantClient.complete_checkout) and the merchant's
// verifySignature middleware share this exact module for transport signing, so
// the tests exercise the real signing path rather than a reimplementation.
const { canonicalize, sign } = require('../jcs-hmac');
// Independent raw-bytes HMAC-SHA256(hex) check — the same computation the
// server middleware runs against x-ap2-signature, so verifying `canonical`
// here proves a signature the merchant would accept.
const { verifyRazorpaySignature } = require('../src/lib/verifyRazorpaySignature');

const SECRET = 'mcp_test_secret';
const BASE = 'http://merchant.test';

// The cap the human signed for. Every budget assertion below is measured against
// this, not against anything the agent supplied.
const GRANT_ID = 'man_int_mcp_tools_test';
const GRANT_CAP_PAISE = 200000; // ₹2,000

function seedGrant(capPaise = GRANT_CAP_PAISE) {
  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(GRANT_PRINCIPAL);
  db.prepare(
    `INSERT INTO delegation_grants
       (mandate_id, principal_id, agent_id, mandate_json, max_amount_paise,
        challenge, credential_id, status, issued_at, expires_at, revoked_at)
     VALUES (?, ?, 'buyer_agent_1', '{}', ?, 'ch', 'cred', 'active', ?, ?, NULL)`
  ).run(
    GRANT_ID,
    GRANT_PRINCIPAL,
    capPaise,
    new Date(Date.now() - 1000).toISOString(),
    new Date(Date.now() + 3600_000).toISOString()
  );
}

beforeEach(() => seedGrant());

afterAll(() => {
  db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(GRANT_PRINCIPAL);
});

// A fetch-shaped response object (subset of the WHATWG Response API).
function jsonResponse(status, bodyObj) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    },
    async json() {
      return bodyObj;
    },
  };
}

// Build a mock fetch that records each request and replies via `handler(call)`.
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let parsedBody;
    if (init.body) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch (_e) {
        parsedBody = init.body;
      }
    }
    const call = { url, method: init.method || 'GET', headers: init.headers || {}, body: parsedBody };
    calls.push(call);
    return handler(call);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// Feed shaped like GET /api/v1/products: the narrow, token-truncated,
// rupee-denominated row the route now returns to the agent.
const FEED = {
  products: [
    { sku: 'prod_electronics_001', name: 'Boult Audio Z40 Earbuds', price_inr: 1799, stock: 12 },
    { sku: 'prod_electronics_002', name: 'Mi Power Bank 3i', price_inr: 1999, stock: 40 },
    { sku: 'prod_electronics_003', name: 'Noise Smartwatch', price_inr: 2499, stock: 0 },
  ],
  count: 3,
};

describe('TOOL_DEFINITIONS (air-gap surface)', () => {
  test('exposes exactly the 7 ACP checkout tools (5 spec + update_cart + get_recovery_offers deviation)', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
    expect(names).toEqual([
      'cancel_checkout',
      'complete_checkout',
      'create_cart',
      'get_cart_state',
      'get_recovery_offers',
      'search_catalog',
      'update_cart',
    ]);
  });

  test('no mandate / signature / jws field is a tool INPUT property (agent never supplies them)', () => {
    // Collect every property NAME the agent could be asked to supply, at any
    // depth. Descriptions may mention mandates (they explain the air-gap); what
    // matters is that no INPUT key requires the agent to build one.
    const names = [];
    const collect = (schema) => {
      if (!schema || typeof schema !== 'object') return;
      if (schema.properties) {
        for (const key of Object.keys(schema.properties)) {
          names.push(key.toLowerCase());
          collect(schema.properties[key]);
        }
      }
      if (schema.items) collect(schema.items);
    };
    TOOL_DEFINITIONS.forEach((t) => collect(t.inputSchema));

    for (const forbidden of ['mandate', 'signature', 'jws', 'paise', 'proof']) {
      expect(names.some((n) => n.includes(forbidden))).toBe(false);
    }
    // Sanity: the agent only ever supplies simple rupee/id/quantity inputs.
    expect(names).toEqual(
      expect.arrayContaining(['query', 'budget_in_rupees', 'item_id', 'quantity', 'session_id'])
    );
  });
});

describe('canonicalize + sign (transport crypto — the shared jcs-hmac module)', () => {
  test('canonicalize is key-order independent', () => {
    const a = { b: 1, a: { d: 4, c: 3 }, arr: [{ y: 2, x: 1 }] };
    const b = { a: { c: 3, d: 4 }, arr: [{ x: 1, y: 2 }], b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  test('sign produces a stable HMAC over the canonical bytes that verifies', () => {
    // A Shape-C PaymentMandate, wrapped exactly as complete_checkout signs it:
    // sign({ payment_mandate }, secret).
    const payload = {
      payment_mandate: {
        mandate_type: 'PaymentMandate',
        payment_id: 'mnd_fixed',
        cart_id: 'cart_fixed',
        intent_reference: 'intent_fixed',
        final_paise: 179900,
        created_at: '2026-08-22T10:15:00.000Z',
      },
    };

    const { canonical, signature } = sign(payload, SECRET);
    // The transport signature is a hex SHA-256 HMAC digest.
    expect(typeof signature).toBe('string');
    expect(signature).toHaveLength(64);
    // `canonical` is the exact JCS string the client puts on the wire as the body.
    expect(canonical).toBe(canonicalize(payload));

    // The merchant's verifySignature middleware HMACs the raw received bytes and
    // compares to x-ap2-signature; verifyRazorpaySignature is that same raw-bytes
    // HMAC-SHA256(hex) check, so verifying `canonical` here mirrors the server.
    expect(verifyRazorpaySignature(canonical, signature, SECRET)).toBe(true);

    // Deterministic: signing the same content again yields the same digest.
    expect(sign(payload, SECRET).signature).toBe(signature);

    // A different secret must NOT verify.
    expect(verifyRazorpaySignature(canonical, signature, 'wrong_secret')).toBe(false);
  });
});

describe('paise conversion (Paise Converter air-gap)', () => {
  test('search_catalog: budget_in_rupees is applied as *100 paise, plus availability', async () => {
    const filteredFeed = {
      products: FEED.products.filter((p) => p.price_inr <= 1800 && p.stock > 0),
      count: 1,
    };
    const fetchImpl = makeFetch(() => jsonResponse(200, filteredFeed));
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });

    // 1800 rupees = 180000 paise: only prod_001 (₹1799, in stock) qualifies.
    const out = await tools.search_catalog({ query: 'earbuds', budget_in_rupees: 1800 });
    expect(out.count).toBe(1);
    expect(out.products[0].item_id).toBe('prod_electronics_001');
    expect(out.products[0].price_in_rupees).toBe(1799);
    // Paise never crosses back to the agent — the merchant prices the cart.
    expect(out.products[0]).not.toHaveProperty('price_in_paise');

    expect(fetchImpl.calls[0].url).toBe(BASE + '/api/v1/products?query=earbuds&max_price=180000');
    expect(fetchImpl.calls[0].method).toBe('GET');
  });

  test('search_catalog: rejects an empty/missing query before any merchant call', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(200, FEED));
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });

    await expect(tools.search_catalog({})).rejects.toThrow(/query. is required/);
    await expect(tools.search_catalog({ query: '   ' })).rejects.toThrow(/query. is required/);
    expect(fetchImpl.calls).toHaveLength(0); // no wasted round trip
  });

  test('search_catalog: forwards category and advises refinement on no matches', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(200, { products: [], count: 0 }));
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });

    const out = await tools.search_catalog({ query: 'ergonomic chair', category: 'furniture' });
    expect(out.count).toBe(0);
    expect(out.advice).toMatch(/[Rr]efine/);
    expect(fetchImpl.calls[0].url).toBe(
      BASE + '/api/v1/products?query=ergonomic+chair&category=furniture'
    );
  });

  test('search_catalog: query filters by title/description substring', async () => {
    const filteredFeed = {
      products: FEED.products.filter((p) => p.name.toLowerCase().includes('power bank')),
      count: 1,
    };
    const fetchImpl = makeFetch(() => jsonResponse(200, filteredFeed));
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    const out = await tools.search_catalog({ query: 'power bank' });
    expect(out.count).toBe(1);
    expect(out.products[0].item_id).toBe('prod_electronics_002');
    expect(out.products[0].title).toBe('Mi Power Bank 3i');
  });

  test('create_cart: references the human-signed grant and ignores an agent-supplied budget', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(201, {
        session_id: 'acp_sess_1',
        state: 'CREATED',
        cart_mandate: { mandate_id: 'mnd_cart_1' },
        amount_total: 179900,
        currency: 'INR',
        expires_at: '2026-01-01T00:00:00Z',
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    const out = await tools.create_cart({ item_id: 'prod_electronics_001', quantity: 1, budget_in_rupees: 2000 });

    const body = fetchImpl.calls[0].body;
    expect(fetchImpl.calls[0].url).toBe(BASE + '/api/v1/checkout/sessions');
    // The agent references the grant; it does not carry an envelope it signed.
    // If an intent_mandate ever reappears here, the agent is authorizing itself.
    expect(body.intent_mandate_id).toBe(GRANT_ID);
    expect(body).not.toHaveProperty('intent_mandate');
    expect(body.requested_items).toEqual([{ sku: 'prod_electronics_001', quantity: 1 }]);

    expect(out.session_id).toBe('acp_sess_1');
    expect(out.amount_total_paise).toBe(179900);
    expect(out.amount_total_rupees).toBe(1799);
    expect(out.cart_mandate_id).toBe('mnd_cart_1');
    expect(out.budget_exceeded).toBeUndefined(); // 179900 <= the grant's 200000
  });

  test('create_cart: YIELDs to the human when no grant authorizes the agent', async () => {
    db.prepare('DELETE FROM delegation_grants WHERE principal_id = ?').run(GRANT_PRINCIPAL);
    const fetchImpl = makeFetch(() => jsonResponse(201, {}));
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });

    await expect(tools.create_cart({ item_id: 'prod_electronics_001' })).rejects.toThrow(/YIELD_TO_HUMAN/);
    // No grant, no call: the tool stops rather than falling back to self-issued authority.
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test('create_cart: items[] array maps to requested_items with skus', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(201, {
        session_id: 's',
        state: 'CREATED',
        cart_mandate: { cart_id: 'm' },
        amount_total: 379800,
        currency: 'INR',
        expires_at: 'x',
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    await tools.create_cart({
      items: [
        { item_id: 'prod_electronics_001', quantity: 1 },
        { item_id: 'prod_electronics_002', quantity: 1 },
      ],
      budget_in_rupees: 5000,
    });
    expect(fetchImpl.calls[0].body.requested_items).toEqual([
      { sku: 'prod_electronics_001', quantity: 1 },
      { sku: 'prod_electronics_002', quantity: 1 },
    ]);
  });

  test('create_cart: surfaces a non-silent budget_exceeded advisory against the grant cap', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(201, {
        session_id: 'acp_sess_2',
        state: 'CREATED',
        cart_mandate: { cart_id: 'mnd_cart_2' },
        amount_total: 359800, // 2 x 179900
        currency: 'INR',
        expires_at: '2026-01-01T00:00:00Z',
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    // The agent asks for a budget far above the grant. It is ignored: the
    // advisory is measured against what the human signed.
    const out = await tools.create_cart({ item_id: 'prod_electronics_001', quantity: 2, budget_in_rupees: 99999 });

    expect(out.budget_exceeded).toBeDefined();
    expect(out.budget_exceeded.budget_paise).toBe(GRANT_CAP_PAISE);
    expect(out.budget_exceeded.amount_total_paise).toBe(359800);
    expect(out.budget_exceeded.over_by_paise).toBe(159800);
  });
});

describe('update_cart (§3.5 deviation — revise a CREATED cart)', () => {
  test('PATCHes the session and maps the re-priced total to paise + rupees (no new mandate)', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(200, {
        session_id: 'acp_sess_1',
        state: 'CREATED',
        cart_mandate: { mandate_id: 'mnd_cart_2' },
        amount_total: 199900,
        currency: 'INR',
        expires_at: '2026-01-01T00:00:00Z',
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    const out = await tools.update_cart({ session_id: 'acp_sess_1', item_id: 'prod_electronics_002', quantity: 1 });

    const call = fetchImpl.calls[0];
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe(BASE + '/api/v1/checkout/sessions/acp_sess_1');
    expect(call.body.requested_items).toEqual([{ sku: 'prod_electronics_002', quantity: 1 }]);
    // Update never mints a mandate — the merchant re-prices and re-issues the cart.
    expect(call.body.intent_mandate).toBeUndefined();

    // #4 (Day-9 red-team): the revise boundary is transport-signed too (same
    // JCS+HMAC path as create/complete), so the merchant's verifySignature guard
    // The server recalculates pricing and re-mints the CartMandate internally.
    expect(out.session_id).toBe('acp_sess_1');
    expect(out.amount_total_paise).toBe(199900);
    expect(out.amount_total_rupees).toBe(1999);
    expect(out.cart_mandate_id).toBe('mnd_cart_2');
    expect(out.budget_exceeded).toBeUndefined(); // no budget supplied → no advisory
  });

  test('items[] array maps to requested_items with skus', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(200, {
        session_id: 's',
        state: 'CREATED',
        cart_mandate: { cart_id: 'm' },
        amount_total: 379800,
        currency: 'INR',
        expires_at: 'x',
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    await tools.update_cart({
      session_id: 's',
      items: [
        { item_id: 'prod_electronics_001', quantity: 1 },
        { item_id: 'prod_electronics_002', quantity: 1 },
      ],
    });
    expect(fetchImpl.calls[0].body.requested_items).toEqual([
      { sku: 'prod_electronics_001', quantity: 1 },
      { sku: 'prod_electronics_002', quantity: 1 },
    ]);
  });

  test('re-runs the non-silent budget advisory when budget_in_rupees is supplied', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(200, {
        session_id: 'acp_sess_2',
        state: 'CREATED',
        cart_mandate: { cart_id: 'mnd_cart_2' },
        amount_total: 359800, // 2 x 179900
        currency: 'INR',
        expires_at: 'x',
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    const out = await tools.update_cart({
      session_id: 'acp_sess_2',
      item_id: 'prod_electronics_001',
      quantity: 2,
      budget_in_rupees: 2000,
    });
    expect(out.budget_exceeded).toBeDefined();
    expect(out.budget_exceeded.budget_paise).toBe(200000);
    expect(out.budget_exceeded.over_by_paise).toBe(159800);
  });

  test('YIELDs to human when the session has moved past CREATED (409 retriable:false)', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(409, {
        error: {
          code: 'INVALID_STATE_TRANSITION',
          message: 'Cannot revise session in state PAID',
          retriable: false,
          session_id: 'acp_sess_paid',
        },
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    await expect(
      tools.update_cart({ session_id: 'acp_sess_paid', item_id: 'prod_electronics_001' })
    ).rejects.toThrow('YIELD_TO_HUMAN: Unrecoverable checkout state.');
  });

  test('requires session_id and fails before any merchant call', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(200, {}));
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    await expect(tools.update_cart({ item_id: 'prod_electronics_001' })).rejects.toThrow(
      'session_id is required'
    );
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('circuit breaker (req #4 — no silent retries)', () => {
  test('4xx + retriable:false throws the YIELD_TO_HUMAN signal', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(409, {
        error: {
          code: 'INVALID_STATE_TRANSITION',
          message: 'Cannot complete session in state PAID',
          retriable: false,
          session_id: 'acp_sess_x',
        },
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    await expect(tools.get_cart_state({ session_id: 'acp_sess_x' })).rejects.toThrow(
      'YIELD_TO_HUMAN: Unrecoverable checkout state.'
    );
  });

  test('4xx + retriable:true throws a plain error WITHOUT the YIELD string', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(400, { error: { code: 'TEMPORARY_LOCK', message: 'retry shortly', retriable: true } })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });

    let caught;
    try {
      await tools.get_cart_state({ session_id: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message).not.toContain('YIELD_TO_HUMAN');
    expect(caught.message).toContain('TEMPORARY_LOCK');
  });

  test('a single merchant call is made — the breaker never retries', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(404, { error: { code: 'SESSION_NOT_FOUND', message: 'nope', retriable: false } })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    await expect(tools.cancel_checkout({ session_id: 'ghost' })).rejects.toThrow('YIELD_TO_HUMAN');
    expect(fetchImpl.calls).toHaveLength(1);
  });
});

describe('get_cart_state (air-gap — no raw paise leak)', () => {
  test('adds rupee companions to amount and every line-item unit_price', async () => {
    const stateBody = {
      order_id: 'ord_1',
      session_id: 'acp_sess_1',
      state: 'CREATED',
      amount: 359800, // paise (2 x 179900)
      currency: 'INR',
      // The wire shape is the CartMandate's line_items: {sku, title, category,
      // quantity, unit_price}, with unit_price in paise.
      line_items: [
        {
          sku: 'prod_electronics_001',
          title: 'Earbuds',
          category: 'audio',
          quantity: 2,
          unit_price: 179900,
        },
      ],
      mandate_chain: { intent_mandate_id: null, cart_mandate_id: 'mnd_cart_1', payment_mandate_id: null },
      razorpay: { order_id: null, payment_id: null, payment_link_id: null },
    };
    const fetchImpl = makeFetch(() => jsonResponse(200, stateBody));
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    const out = await tools.get_cart_state({ session_id: 'acp_sess_1' });

    // Paise preserved (authoritative) AND rupee companion present, for both the
    // session amount and every line item's paise-denominated fields.
    expect(out.amount).toBe(359800);
    expect(out.amount_in_rupees).toBe(3598);
    expect(out.line_items[0].unit_price).toBe(179900);
    expect(out.line_items[0].unit_price_rupees).toBe(1799);
    expect(out.line_items[0].line_total_rupees).toBe(3598);
    // Non-amount fields pass through untouched.
    expect(out.state).toBe('CREATED');
    expect(out.mandate_chain.cart_mandate_id).toBe('mnd_cart_1');
    expect(fetchImpl.calls[0].url).toBe(BASE + '/api/v1/checkout/sessions/acp_sess_1');
  });
});

describe('complete_checkout (req #5 — explainability)', () => {
  test('200 success surfaces order_id + mandate_hash and sends Idempotency-Key + signed mandate', async () => {
    const fetchImpl = makeFetch(() => {
      return jsonResponse(200, {
        session_id: 'acp_sess_1',
        state: 'CONFIRMED',
        order: { order_id: 'ord_abc', razorpay_order_id: 'order_rzp_123' },
        payment_mandate_id: 'mnd_pay_1',
        next: 'await_webhook',
      });
    });
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    const out = await tools.complete_checkout({ session_id: 'acp_sess_1', idempotency_key: 'idem_fixed' });

    expect(out.order_id).toBe('ord_abc');
    expect(out.razorpay_order_id).toBe('order_rzp_123');
    expect(typeof out.payment_mandate_id).toBe('string');
    expect(out.state).toBe('CONFIRMED');

    // One call: POST /complete with empty body.
    expect(fetchImpl.calls.length).toBe(1);
    const completeCall = fetchImpl.calls[0];
    expect(completeCall.method).toBe('POST');
    expect(completeCall.url).toBe(BASE + '/api/v1/checkout/sessions/acp_sess_1/complete');
    expect(completeCall.headers['Idempotency-Key']).toBe('idem_fixed');

    // Empty body sent, mandate is minted by the server
    expect(completeCall.body).toEqual({});

  });

  test('202 escalation surfaces payment_link_url + mandate_hash (no order)', async () => {
    const fetchImpl = makeFetch((call) => {
      if (call.method === 'GET') {
        return jsonResponse(200, {
          session_id: 'acp_sess_9',
          state: 'CREATED',
          cart_mandate: {
            mandate_type: 'CartMandate',
            cart_id: 'cart_c9',
            intent_reference: 'intent_i9',
            total_paise: 5000000,
          },
        });
      }
      return jsonResponse(202, {
        session_id: 'acp_sess_9',
        state: 'CONFIRMED',
        payment_mandate_id: 'mnd_pay_esc',
        approval: { type: 'payment_link', url: 'https://rzp.io/i/abc', payment_link_id: 'plink_1' },
        next: 'await_human_then_webhook',
      });
    });
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET, autoApproveThresholdPaise: 1000000 });
    const out = await tools.complete_checkout({ session_id: 'acp_sess_9' });

    expect(out.payment_link_url).toBe('https://rzp.io/i/abc');
    expect(out.payment_link_id).toBe('plink_1');
    expect(out.auto_approve_threshold_paise).toBe(1000000);
    expect(typeof out.payment_mandate_id).toBe('string');
    expect(out.order_id).toBeUndefined();
    expect(out.idempotency_key).toMatch(/^idem_/); // auto-generated
  });

  test('complete_checkout auto-generates an Idempotency-Key when omitted', async () => {
    const fetchImpl = makeFetch((call) => {
      if (call.method === 'GET') {
        return jsonResponse(200, {
          session_id: 's',
          state: 'CREATED',
          cart_mandate: {
            mandate_type: 'CartMandate',
            cart_id: 'cart_s',
            intent_reference: 'intent_s',
            total_paise: 179900,
          },
        });
      }
      return jsonResponse(200, {
        session_id: 's',
        state: 'CONFIRMED',
        order: { order_id: 'o', razorpay_order_id: 'r' },
        next: 'await_webhook',
      });
    });
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET });
    await tools.complete_checkout({ session_id: 's' });
    // calls[0] = POST /complete carries the generated key.
    expect(fetchImpl.calls[0].headers['Idempotency-Key']).toMatch(/^idem_/);
  });
});

describe('audit tap (ADR-005 — every tool execution appends one TOOL_CALL block)', () => {
  test('search_catalog appends a TOOL_CALL with {tool, input, output} and chains from genesis', async () => {
    const auditLog = createAuditLog();
    const fetchImpl = makeFetch(() => jsonResponse(200, FEED));
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET, auditLog });

    const input = { query: 'earbuds', budget_in_rupees: 1800 };
    const output = await tools.search_catalog(input);

    const entries = auditLog.entries();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.event_type).toBe('TOOL_CALL');
    expect(e.actor).toBe('buyer_agent'); // the buyer agent invoked the tool
    expect(e.payload.tool).toBe('search_catalog');
    expect(e.payload.input).toEqual(input);
    expect(e.payload.output).toEqual(output); // inputs AND outputs captured
    expect(e.payload).not.toHaveProperty('error');
    expect(e.prev_hash).toBe('0'.repeat(64)); // first link after genesis anchor
    expect(auditLog.verifyChain().valid).toBe(true);
  });

  test('create_cart TOOL_CALL carries the returned session_id as the block session_id', async () => {
    const auditLog = createAuditLog();
    const fetchImpl = makeFetch(() =>
      jsonResponse(201, {
        session_id: 'acp_sess_1',
        state: 'CREATED',
        cart_mandate: { cart_id: 'mnd_cart_1' },
        amount_total: 179900,
        currency: 'INR',
        expires_at: 'x',
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET, auditLog });
    await tools.create_cart({ item_id: 'prod_electronics_001', budget_in_rupees: 2000 });

    // An agent-supplied budget is recorded as ignored before the tool runs, so
    // the trail shows the limit was seen and refused rather than silently used.
    expect(auditLog.entries()[0].payload).toMatchObject({
      note: 'IGNORED_AGENT_SUPPLIED_LIMIT',
      supplied: 2000,
    });

    const e = auditLog.entries().find((x) => x.payload.tool === 'create_cart');
    expect(e).toBeDefined();
    // input had no session_id, so the block is correlated by the output's id.
    expect(e.session_id).toBe('acp_sess_1');
    expect(e.payload.output.session_id).toBe('acp_sess_1');
  });

  test('a failing tool appends a TOOL_CALL with the error message AND rethrows unchanged', async () => {
    const auditLog = createAuditLog();
    const fetchImpl = makeFetch(() =>
      jsonResponse(409, {
        error: { code: 'INVALID_STATE_TRANSITION', message: 'nope', retriable: false },
      })
    );
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET, auditLog });

    await expect(tools.cancel_checkout({ session_id: 'ghost' })).rejects.toThrow('YIELD_TO_HUMAN');

    const entries = auditLog.entries();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.event_type).toBe('TOOL_CALL');
    expect(e.payload.tool).toBe('cancel_checkout');
    expect(e.session_id).toBe('ghost'); // from input, since the tool produced no output
    expect(typeof e.payload.error).toBe('string');
    expect(e.payload.error).toContain('YIELD_TO_HUMAN');
    expect(e.payload).not.toHaveProperty('output');
    expect(auditLog.verifyChain().valid).toBe(true);
  });

  test('successive tool calls chain in order (prev_hash linkage) on the shared instance', async () => {
    const auditLog = createAuditLog();
    const fetchImpl = makeFetch(() => jsonResponse(200, FEED));
    const tools = createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET, auditLog });

    await tools.search_catalog({ query: 'earbuds' });
    await tools.search_catalog({ query: 'power bank' });

    const entries = auditLog.entries();
    expect(entries).toHaveLength(2);
    expect(entries[1].prev_hash).toBe(entries[0].hash);
    expect(auditLog.verifyChain().valid).toBe(true);
  });

  test('defaults to the shared server-wide chain when no auditLog is injected', () => {
    // No fetch call needed — just prove the factory does not require an explicit
    // auditLog (it falls back to sharedAuditLog), so the MCP server wires taps
    // with zero configuration.
    const fetchImpl = makeFetch(() => jsonResponse(200, FEED));
    expect(() => createMerchantTools({ baseUrl: BASE, fetchImpl, secret: SECRET })).not.toThrow();
  });
});
