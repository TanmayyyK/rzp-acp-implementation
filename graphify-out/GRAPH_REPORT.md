# Graph Report - RazorPay  (2026-08-22)

## Corpus Check
- 23 files · ~11,210 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 163 nodes · 184 edges · 15 communities
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `fbcddafd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- 3. API contracts (merchant server ⇄ buyer agent)
- orders.js
- checkout.js
- server.js
- package.json
- 2. Data models (exact JSON)
- webhooks.js
- mockProductFeed.js
- ACP Endpoint Schemas (Day 3)
- devDependencies
- checkout.test.js
- razorpayClient.js
- Architecture Decision Records

## God Nodes (most connected - your core abstractions)
1. `Architecture Decision Records` - 10 edges
2. `ACP Endpoint Schemas (Day 3)` - 8 edges
3. `2. Data models (exact JSON)` - 7 edges
4. `getMockProductFeed()` - 6 edges
5. `3. API contracts (merchant server ⇄ buyer agent)` - 6 edges
6. `scripts` - 5 edges
7. `Agent Commerce Layer for Razorpay` - 5 edges
8. `API Mapping & Cheat Sheet` - 5 edges
9. `getInstance()` - 4 edges
10. `withRetry()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `resolveLineItems()` --calls--> `getMockProductFeed()`  [EXTRACTED]
  src/routes/checkout.js → src/lib/mockProductFeed.js

## Import Cycles
- None detected.

## Communities (15 total, 0 thin omitted)

### Community 0 - "3. API contracts (merchant server ⇄ buyer agent)"
Cohesion: 0.09
Nodes (18): 1. ACP-5 Endpoint Mapping to Razorpay, 2. AP2-3 Mandate Authorization Chain, 3. Webhook Handling Taxonomy, 4. Cryptographic Validation Requirements, API Mapping & Cheat Sheet, 1. Component diagram, 3.1 Authentication (every agent → merchant request), 3.2 Discovery & catalog (+10 more)

### Community 1 - "orders.js"
Cohesion: 0.18
Nodes (9): config, dotenv, ADR-0003, ADR-0004, config, express, ADR-0003, razorpayClient (+1 more)

### Community 2 - "checkout.js"
Cohesion: 0.19
Nodes (10): buildStubMandate(), crypto, expiresIn(), express, generateId(), { getMockProductFeed }, ADR-0007, now() (+2 more)

### Community 3 - "server.js"
Cohesion: 0.11
Nodes (15): CATALOG, express, ADR-0004, router, app, checkoutRouter, config, express (+7 more)

### Community 4 - "package.json"
Cohesion: 0.11
Nodes (18): dotenv, express, dependencies, dotenv, express, razorpay, description, engines (+10 more)

### Community 5 - "2. Data models (exact JSON)"
Cohesion: 0.29
Nodes (7): 2.1 Mandate envelope (shared by all three AP2 mandates), 2.2 IntentMandate — signed by the **buyer** (the user's WebAuthn-backed key, via the agent), 2.3 CartMandate — signed by the **merchant**, 2.4 PaymentMandate — signed by the **merchant server acting as processor-of-record**, 2.5 Order object (our internal record; 1:1 with a Razorpay order and a mandate chain), 2.6 Audit log entry (hash-chained, append-only), 2. Data models (exact JSON)

### Community 6 - "webhooks.js"
Cohesion: 0.15
Nodes (11): crypto, verifyRazorpaySignature(), express, ADR-0007, processedEventIds, TODO: Drive state machine → FAILED (Day 12), router, { verifyRazorpaySignature } (+3 more)

### Community 7 - "mockProductFeed.js"
Cohesion: 0.27
Nodes (8): buildProduct(), getMockProductFeed(), rupeesToPaise(), resolveLineItems(), express, { getMockProductFeed }, router, { getMockProductFeed, rupeesToPaise }

### Community 8 - "ACP Endpoint Schemas (Day 3)"
Cohesion: 0.22
Nodes (8): 1. Create Checkout Session, 2. Update Checkout Session, 3. Get Session State, 4. Complete Checkout, 5. Cancel Checkout, ACP Endpoint Schemas (Day 3), Common Types & Models, Global Error Schema

### Community 9 - "devDependencies"
Cohesion: 0.29
Nodes (7): eslint, jest, devDependencies, eslint, jest, supertest, supertest

### Community 10 - "checkout.test.js"
Cohesion: 0.38
Nodes (5): app, checkoutRouter, createSession(), request, stubIntentMandate()

### Community 13 - "razorpayClient.js"
Cohesion: 0.29
Nodes (10): config, createOrder(), createPaymentLink(), fetchOrder(), getInstance(), ADR-0003, ADR-0004, ADR-0007 (+2 more)

### Community 14 - "Architecture Decision Records"
Cohesion: 0.20
Nodes (10): ADR-001 — Merchant server and buyer agent are two independent services, joined by MCP, ADR-002 — The AP2 three-mandate chain is the authorization backbone; each party signs its own link, ADR-003 — Razorpay Orders is the money primitive; Payment Links is the human-in-the-loop rail, ADR-004 — Money is an integer in minor units (paise); never a float, ADR-005 — The audit trail is a hash-chained append-only log, ADR-006 — Guardrails are pure, server-side functions enforced at every mandate boundary (defense in depth), ADR-007 — Idempotency on every state-mutating call; async state only from verified webhooks, ADR-008 — Agent identity via attestation header bound to a WebAuthn principal (+2 more)

## Knowledge Gaps
- **101 isolated node(s):** `name`, `version`, `description`, `main`, `node` (+96 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Architecture — Agent Commerce Layer for Razorpay` connect `3. API contracts (merchant server ⇄ buyer agent)` to `2. Data models (exact JSON)`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `Architecture Decision Records` connect `Architecture Decision Records` to `3. API contracts (merchant server ⇄ buyer agent)`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `2. Data models (exact JSON)` connect `2. Data models (exact JSON)` to `3. API contracts (merchant server ⇄ buyer agent)`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _101 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `3. API contracts (merchant server ⇄ buyer agent)` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._