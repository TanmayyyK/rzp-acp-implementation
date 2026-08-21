# Graph Report - RazorPay  (2026-08-22)

## Corpus Check
- 23 files · ~11,107 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 171 nodes · 211 edges · 13 communities
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 13 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5f230ca9`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Architecture Decision Records
- razorpayClient.js
- checkout.js
- server.js
- package.json
- 2. Data models (exact JSON)
- webhooks.js
- mockProductFeed.js
- ACP Endpoint Schemas (Day 3)
- devDependencies
- checkout.test.js

## God Nodes (most connected - your core abstractions)
1. `Architecture Decision Records` - 10 edges
2. `ACP Endpoint Schemas (Day 3)` - 8 edges
3. `createSession()` - 7 edges
4. `2. Data models (exact JSON)` - 7 edges
5. `getMockProductFeed()` - 6 edges
6. `now()` - 6 edges
7. `buildStubMandate()` - 6 edges
8. `errorResponse()` - 6 edges
9. `updateSession()` - 6 edges
10. `attachSessionRoutes()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `resolveLineItems()` --calls--> `getMockProductFeed()`  [EXTRACTED]
  src/routes/checkout.js → src/lib/mockProductFeed.js

## Import Cycles
- None detected.

## Communities (13 total, 0 thin omitted)

### Community 0 - "Architecture Decision Records"
Cohesion: 0.09
Nodes (20): 1. ACP-5 Endpoint Mapping to Razorpay, 2. AP2-3 Mandate Authorization Chain, 3. Webhook Handling Taxonomy, 4. Cryptographic Validation Requirements, API Mapping & Cheat Sheet, ADR-001 — Merchant server and buyer agent are two independent services, joined by MCP, ADR-002 — The AP2 three-mandate chain is the authorization backbone; each party signs its own link, ADR-003 — Razorpay Orders is the money primitive; Payment Links is the human-in-the-loop rail (+12 more)

### Community 1 - "razorpayClient.js"
Cohesion: 0.12
Nodes (19): config, dotenv, ADR-0003, ADR-0004, config, createOrder(), createPaymentLink(), fetchOrder() (+11 more)

### Community 2 - "checkout.js"
Cohesion: 0.23
Nodes (19): attachSessionRoutes(), buildStubMandate(), cancelCheckout(), completeCheckout(), createSession(), crypto, errorResponse(), expiresIn() (+11 more)

### Community 3 - "server.js"
Cohesion: 0.10
Nodes (16): CATALOG, express, ADR-0004, router, app, checkoutRouter, config, express (+8 more)

### Community 4 - "package.json"
Cohesion: 0.11
Nodes (18): dotenv, express, dependencies, dotenv, express, razorpay, description, engines (+10 more)

### Community 5 - "2. Data models (exact JSON)"
Cohesion: 0.12
Nodes (15): 1. Component diagram, 2.1 Mandate envelope (shared by all three AP2 mandates), 2.2 IntentMandate — signed by the **buyer** (the user's WebAuthn-backed key, via the agent), 2.3 CartMandate — signed by the **merchant**, 2.4 PaymentMandate — signed by the **merchant server acting as processor-of-record**, 2.5 Order object (our internal record; 1:1 with a Razorpay order and a mandate chain), 2.6 Audit log entry (hash-chained, append-only), 2. Data models (exact JSON) (+7 more)

### Community 6 - "webhooks.js"
Cohesion: 0.14
Nodes (12): crypto, verifyRazorpaySignature(), express, ADR-0007, processedEventIds, TODO: Drive state machine CONFIRMED → PAID (Day 4+), TODO: Drive state machine → FAILED (Day 12), router (+4 more)

### Community 7 - "mockProductFeed.js"
Cohesion: 0.31
Nodes (7): buildProduct(), getMockProductFeed(), rupeesToPaise(), express, { getMockProductFeed }, router, { getMockProductFeed, rupeesToPaise }

### Community 8 - "ACP Endpoint Schemas (Day 3)"
Cohesion: 0.22
Nodes (8): 1. Create Checkout Session, 2. Update Checkout Session, 3. Get Session State, 4. Complete Checkout, 5. Cancel Checkout, ACP Endpoint Schemas (Day 3), Common Types & Models, Global Error Schema

### Community 9 - "devDependencies"
Cohesion: 0.29
Nodes (7): eslint, jest, devDependencies, eslint, jest, supertest, supertest

### Community 10 - "checkout.test.js"
Cohesion: 0.38
Nodes (5): app, checkoutRouter, createSession(), request, stubIntentMandate()

## Knowledge Gaps
- **102 isolated node(s):** `name`, `version`, `description`, `main`, `node` (+97 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `name`, `version`, `description` to the rest of the system?**
  _102 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Architecture Decision Records` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._
- **Should `razorpayClient.js` be split into smaller, more focused modules?**
  _Cohesion score 0.12121212121212122 - nodes in this community are weakly interconnected._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._
- **Should `2. Data models (exact JSON)` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._
- **Should `webhooks.js` be split into smaller, more focused modules?**
  _Cohesion score 0.14166666666666666 - nodes in this community are weakly interconnected._