# Graph Report - RazorPay  (2026-09-01)

## Corpus Check
- 104 files · ~97,077 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1137 nodes · 1695 edges · 101 communities (67 shown, 34 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 110 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6cb03d30`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- mcpMerchantTools.test.js
- intent-mandate.schema.json
- properties
- Architecture Decision Records
- cart-mandate.schema.json
- checkout.js
- properties
- audit.ts
- compilerOptions
- razorpayClient.js
- src/server.js
- trust.js
- validate.js
- package.json
- verify_flow.js
- inject
- handle
- Architecture — Agentic Commerce & Agent Circle Trust Engine
- auditLog.js
- chat.js
- js/delegation.js
- index.ts
- durableCommerceStore.js
- velocityTracker.js
- merchantClient.js
- adversarial-judge-repro.test.js
- webhooks.js
- guardrails.test.js
- checkout.test.js
- Colors
- mandates.js
- humanAuthorizationBoundary.test.js
- chaosEngine.js
- judge_evaluation_report.md
- store.js
- createMerchantTools
- mandates.ts
- ui.js
- x402Adapter.js
- humanAuthorization.js
- server.test.js
- judge_report.md
- softAuthenticator.js
- sharedAuditLog
- ACP Endpoint Schemas (Day 3)
- delegationGrants.js
- webauthnClient.js
- SqliteSessionStore
- dependencies
- seed_massive.js
- db.js
- index.js
- auth.js
- test2_debug.js
- lib/delegation.js
- test2.js
- test2_loop.js
- razorpayIdempotencyWrapper.js
- orders.js
- products.js
- user.js
- inject.js
- update_auth.js
- update_checkout.js
- update_velocityTracker.js
- update_x402.js
- AGENTS.md
- @ai-sdk/groq
- autoprefixer
- better-sqlite3
- class-variance-authority
- clsx
- dotenv
- express-session
- fix_test.sh
- fix_tests.sh
- lucide-react
- @modelcontextprotocol/sdk
- next
- express
- @radix-ui/react-slot
- razorpay
- react
- react-dom
- @simplewebauthn/server
- tailwind-merge
- tailwindcss
- @types/node
- @types/react
- @types/react-dom
- typescript
- run_tests.sh
- run_tests2.sh
- run_tests3.sh

## God Nodes (most connected - your core abstractions)
1. `inject()` - 33 edges
2. `createMerchantTools()` - 24 edges
3. `compilerOptions` - 16 edges
4. `sharedAuditLog` - 14 edges
5. `render()` - 13 edges
6. `canonicalize()` - 12 edges
7. `main()` - 12 edges
8. `submit()` - 11 edges
9. `validateIntentMandate()` - 11 edges
10. `handle()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `run()` --calls--> `createMerchantTools()`  [EXTRACTED]
  tests/test2_debug.js → src/mcp/merchantClient.js
- `run()` --calls--> `createMerchantTools()`  [EXTRACTED]
  tests/test2_loop.js → src/mcp/merchantClient.js
- `run()` --calls--> `createMerchantTools()`  [EXTRACTED]
  tests/test2.js → src/mcp/merchantClient.js
- `server` --calls--> `createMerchantTools()`  [EXTRACTED]
  tests/test_tools.js → src/mcp/merchantClient.js
- `generateTransactionChallenge()` --calls--> `canonicalize()`  [EXTRACTED]
  src/circle/webauthn.js → jcs-hmac.js

## Import Cycles
- None detected.

## Communities (101 total, 34 thin omitted)

### Community 0 - "mcpMerchantTools.test.js"
Cohesion: 0.06
Nodes (34): assertValidSecret(), canonicalize(), createSignedEnvelope(), crypto, isPlainObject(), RFC-8785, serializeArray(), serializeNumber() (+26 more)

### Community 1 - "intent-mandate.schema.json"
Cohesion: 0.04
Nodes (45): allowed_categories, expiry_timestamp, intent_id, max_paise, additionalProperties, description, items, minItems (+37 more)

### Community 2 - "properties"
Cohesion: 0.04
Nodes (45): CARD, final_paise, NETBANKING, payment_id, UPI, WALLET, additionalProperties, description (+37 more)

### Community 3 - "Architecture Decision Records"
Cohesion: 0.05
Nodes (40): 1. ACP-5 Endpoint Mapping to Razorpay, 2. AP2-3 Mandate Authorization Chain, 3. Webhook Handling Taxonomy, 4. Cryptographic Validation Requirements, API Mapping & Cheat Sheet, 1. System Architecture Overview, 2. Invariable Core Principles, 3.1 x402 Adapter (`src/adapters/x402Adapter.js`) (+32 more)

### Community 4 - "cart-mandate.schema.json"
Cohesion: 0.05
Nodes (40): line_items, total_paise, additionalProperties, description, format, type, format, type (+32 more)

### Community 5 - "checkout.js"
Cohesion: 0.07
Nodes (33): signEdDSA(), auditGuardrailDecisions(), authenticateCheckout(), authorizeCompletion(), buildCartMandate(), codedError(), {
  createSessionStore,
  getCompletionResponse,
  recordCompletionResponse,
  getPaymentAttempt,
  beginPaymentAttempt,
  setPaymentAttempt,
  tryAcquireCheckoutLock,
  releaseCheckoutLock,
}, crypto (+25 more)

### Community 6 - "properties"
Cohesion: 0.06
Nodes (34): description, line_total_paise, locked, quantity, sku, unit_price_paise, $defs, LineItem (+26 more)

### Community 7 - "audit.ts"
Cohesion: 0.08
Nodes (25): amountPaiseOf(), AuditEntry, AuditSnapshot, FEED_TYPES, feedView, formatClock(), formatPaise(), formatRupees() (+17 more)

### Community 8 - "compilerOptions"
Cohesion: 0.07
Nodes (27): dom, dom.iterable, esnext, .next/dev/types/**/*.ts, next-env.d.ts, .next/types/**/*.ts, node_modules, **/*.ts (+19 more)

### Community 9 - "razorpayClient.js"
Cohesion: 0.13
Nodes (23): cancelPaymentLink(), config, createOrder(), createPaymentLink(), fetchOrder(), findOrderByReceipt(), getInstance(), ADR-0003 (+15 more)

### Community 10 - "src/server.js"
Cohesion: 0.08
Nodes (22): app, authRouter, checkoutRouter, config, { createMerchantTools, TOOL_DEFINITIONS }, express, { generateEd25519KeyPair }, ADR-0005 (+14 more)

### Community 11 - "trust.js"
Cohesion: 0.17
Nodes (21): close(), el(), ensureGroup(), fmtDuration(), fmtStamp(), p(), fmtTime(), focusables() (+13 more)

### Community 12 - "validate.js"
Cohesion: 0.24
Nodes (23): CART_CLAIMS, checkCartAgainstIntent(), checkCartArithmetic(), checkNoExtraProps(), checkPaymentAgainstCart(), ENVELOPE_PROPS, fail(), INTENT_CLAIMS (+15 more)

### Community 13 - "package.json"
Cohesion: 0.09
Nodes (21): eslint, jest, description, devDependencies, eslint, jest, supertest, engines (+13 more)

### Community 14 - "verify_flow.js"
Cohesion: 0.17
Nodes (21): agentCompletes(), agentCreatesCart(), agentHeaders(), app, assert(), db, get(), idempotencyKey() (+13 more)

### Community 15 - "inject"
Cohesion: 0.14
Nodes (17): agentCreatesCart(), agentHeaders(), app, checkoutRouter, completeInFlight(), crypto, db, humanApproves() (+9 more)

### Community 16 - "handle"
Cohesion: 0.13
Nodes (15): ALL_ZERO, app, { handle }, ADR-0005, { sharedAuditLog }, { handle }, postChat(), { handle } (+7 more)

### Community 17 - "Architecture — Agentic Commerce & Agent Circle Trust Engine"
Cohesion: 0.10
Nodes (19): 1. System Architecture Overview, 2. Invariable Core Principles, 3.1 x402 Adapter (`src/adapters/x402Adapter.js`), 3.2 AP2 Mandate Chain (`schemas/validate.js`, `src/lib/jcs-eddsa.js`), 3.3 ACP 5-Stage REST Interface (`src/routes/checkout.js`), 3. Protocol Adapters & Ingress Layer, 4.1 WebAuthn & Human Identity (`src/circle/webauthn.js`, `src/routes/auth.js`), 4.2 Delegation Engine (`src/lib/delegation.js`) (+11 more)

### Community 18 - "auditLog.js"
Cohesion: 0.16
Nodes (18): Actor, { canonicalize }, computeHash(), createAuditLog(), append(), verifyChain(), createPersistentAuditLog(), entries() (+10 more)

### Community 19 - "chat.js"
Cohesion: 0.25
Nodes (18): addBubble(), addReceipt(), trow(), addThinkingLive(), appendNarration(), autogrow(), dismissHero(), el() (+10 more)

### Community 20 - "js/delegation.js"
Cohesion: 0.39
Nodes (17): api(), approvePending(), authenticate(), bind(), button(), delegate(), errorText(), guard() (+9 more)

### Community 21 - "index.ts"
Cohesion: 0.24
Nodes (17): ajv, ChainValidationResult, checkCartAgainstIntent(), checkCartArithmetic(), checkPaymentAgainstCart(), compiledCart, compiledIntent, compiledPayment (+9 more)

### Community 22 - "durableCommerceStore.js"
Cohesion: 0.19
Nodes (16): beginPaymentAttempt(), claimWebhook(), completeWebhook(), createSessionStore(), db, findSessionByRazorpayReference(), getCompletionResponse(), getPaymentAttempt() (+8 more)

### Community 23 - "velocityTracker.js"
Cohesion: 0.18
Nodes (15): assertPositiveInteger(), assertPrincipalId(), checkVelocity(), commitSpend(), crypto, db, DEFAULT_MAX_COUNT_PER_WINDOW, inWindow() (+7 more)

### Community 24 - "merchantClient.js"
Cohesion: 0.12
Nodes (16): config, crypto, enrichStateWithRupees(), grants, ADR-0005, ADR-0008, paiseToRupees(), NOTE: this module holds no signing key, by design. (+8 more)

### Community 25 - "adversarial-judge-repro.test.js"
Cohesion: 0.13
Nodes (16): agentCompletes(), agentCreatesCart(), agentHeaders(), app, checkoutRouter, { createAuditLog, sharedAuditLog }, { createMerchantTools }, crypto (+8 more)

### Community 26 - "webhooks.js"
Cohesion: 0.12
Nodes (14): ALLOWED_TRANSITIONS, InvalidStateTransitionError, STATES, TERMINAL_STATES, transitionSession(), { claimWebhook, completeWebhook, findSessionByRazorpayReference, setPaymentAttempt }, { commitSpend, releaseSpend }, express (+6 more)

### Community 27 - "guardrails.test.js"
Cohesion: 0.19
Nodes (15): checkCategoryAllowlist(), checkQuantityLimits(), createReplayTracker(), DEFAULT_VELOCITY, describeFailure(), errorCodeFor(), evaluateCartGuardrails(), GUARDRAIL_ERROR_CODES (+7 more)

### Community 28 - "checkout.test.js"
Cohesion: 0.19
Nodes (16): agentHeaders(), app, cancelSession(), checkoutRouter, completeSession(), createSession(), crypto, db (+8 more)

### Community 29 - "Colors"
Cohesion: 0.12
Nodes (15): Colors, Component conventions, Core brand palette, CSS custom properties, Design principles, Elevation and texture, Full resolved token set, Inverse (overlays and modals) (+7 more)

### Community 30 - "mandates.js"
Cohesion: 0.13
Nodes (12): accountCapPaise(), config, crypto, db, express, grants, humanAuth, resolveRequestedCap() (+4 more)

### Community 31 - "humanAuthorizationBoundary.test.js"
Cohesion: 0.14
Nodes (15): agentCompletes(), agentCreatesCart(), agentHeaders(), app, checkoutRouter, { createMerchantTools }, crypto, db (+7 more)

### Community 32 - "chaosEngine.js"
Cohesion: 0.22
Nodes (11): buildMockPaymentFailedWebhook(), cardDecline(), CHAOS_MODES, chaosEvents, chaosGuard(), { EventEmitter }, inflateAmount(), inflatePaise() (+3 more)

### Community 33 - "judge_evaluation_report.md"
Cohesion: 0.15
Nodes (12): 1. Money-Eating Webhook Drop via Unsafe Cancellation, 2. Velocity Budget Denial of Service (DoS), 3. Missing Lock Acquisition in `cancel_checkout`, 4. Phantom Quantity Guardrail, CRITICAL VULNERABILITIES, EXECUTIVE VERDICT, FINAL SCORECARD, THE 3 THINGS THAT WOULD MAKE ME REJECT IT (+4 more)

### Community 34 - "store.js"
Cohesion: 0.23
Nodes (8): amountPaiseOf(), emit(), feedView(), formatPaise(), formatRupees(), narrate(), poll(), snapshot()

### Community 35 - "createMerchantTools"
Cohesion: 0.35
Nodes (12): buildCartResult(), buildRequestedItems(), createMerchantTools(), callMerchant(), cancel_checkout(), complete_checkout(), create_cart(), get_cart_state() (+4 more)

### Community 36 - "mandates.ts"
Cohesion: 0.17
Nodes (11): RFC-4122, AP2Mandate, CartMandate, CategorySlug, IntentMandate, ISODateTime, LineItem, Paise (+3 more)

### Community 37 - "ui.js"
Cohesion: 0.36
Nodes (10): buildOverlay(), click(), closeShortcuts(), el(), isTyping(), onKeydown(), openShortcuts(), overlayOpen() (+2 more)

### Community 38 - "x402Adapter.js"
Cohesion: 0.24
Nodes (9): assertIntegerPaise(), generateChallenge(), InvalidProtocolError, normalizeLineItems(), { randomUUID }, translateToInternalMandate(), express, { generateChallenge } (+1 more)

### Community 39 - "humanAuthorization.js"
Cohesion: 0.27
Nodes (11): approvalBinding(), assertionChallenge(), buildApprovalRequest(), crypto, db, getCredential(), safeEqual(), verifyApprovalMandate() (+3 more)

### Community 40 - "server.test.js"
Cohesion: 0.18
Nodes (7): app, checkoutRouter, crypto, get(), { inject }, post(), { reserveSpend, checkVelocity }

### Community 41 - "judge_report.md"
Cohesion: 0.20
Nodes (9): BRUTAL RAZORPAY BUILDATHON JUDGE VERDICT, CRITICAL VULNERABILITIES, EXECUTIVE VERDICT, FINAL SCORECARD, THE 3 THINGS THAT WOULD MAKE ME REJECT IT, THE 3 THINGS THAT WOULD MAKE THIS PROJECT WIN, TOP 10 STRENGTHS, TOP 10 WEAKNESSES (+1 more)

### Community 42 - "softAuthenticator.js"
Cohesion: 0.27
Nodes (4): coseEd25519PublicKey(), crypto, sha256(), SoftAuthenticator

### Community 43 - "sharedAuditLog"
Cohesion: 0.20
Nodes (8): sharedAuditLog, app, { handle }, { sharedAuditLog }, app, { createMerchantTools }, server, { sharedAuditLog }

### Community 44 - "ACP Endpoint Schemas (Day 3)"
Cohesion: 0.22
Nodes (8): 1. Create Checkout Session, 2. Update Checkout Session, 3. Get Session State, 4. Complete Checkout, 5. Cancel Checkout, ACP Endpoint Schemas (Day 3), Common Types & Models, Global Error Schema

### Community 45 - "delegationGrants.js"
Cohesion: 0.31
Nodes (6): db, humanAuth, issueGrant(), loadGrant(), resolveActiveGrant(), revokeGrant()

### Community 46 - "webauthnClient.js"
Cohesion: 0.57
Nodes (6): authenticate(), b64urlToBuf(), bufToB64url(), isSupported(), register(), toDescriptors()

### Community 47 - "SqliteSessionStore"
Cohesion: 0.25
Nodes (3): db, session, SqliteSessionStore

### Community 48 - "dependencies"
Cohesion: 0.29
Nodes (7): ai, @ai-sdk/google, dependencies, ai, @ai-sdk/google, postcss, postcss

### Community 49 - "seed_massive.js"
Cohesion: 0.29
Nodes (6): categories, Database, db, dbPath, insert, path

### Community 50 - "db.js"
Cohesion: 0.29
Nodes (5): Database, db, os, path, db

### Community 51 - "index.js"
Cohesion: 0.33
Nodes (5): config, dotenv, ADR-0003, ADR-0004, ADR-0008

### Community 52 - "auth.js"
Cohesion: 0.33
Nodes (4): db, express, router, webauthn

### Community 53 - "test2_debug.js"
Cohesion: 0.33
Nodes (5): app, { createMerchantTools }, db, run(), { sharedAuditLog }

### Community 54 - "lib/delegation.js"
Cohesion: 0.60
Nodes (4): assertNonNegativeFiniteNumber(), DELEGATION_MODES, evaluateDelegation(), evaluateFullDelegation()

### Community 55 - "test2.js"
Cohesion: 0.40
Nodes (4): app, { createMerchantTools }, run(), { sharedAuditLog }

### Community 56 - "test2_loop.js"
Cohesion: 0.40
Nodes (4): app, { createMerchantTools }, run(), { sharedAuditLog }

### Community 60 - "products.js"
Cohesion: 0.50
Nodes (3): db, express, router

### Community 61 - "user.js"
Cohesion: 0.50
Nodes (3): db, express, router

### Community 62 - "inject.js"
Cohesion: 0.50
Nodes (3): fakeSocket(), http, injectFetch()

## Knowledge Gaps
- **556 isolated node(s):** `fix_test.sh script`, `fix_tests.sh script`, `crypto`, `RFC-8785`, `Tone` (+551 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **34 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `package.json`, `@ai-sdk/groq`, `autoprefixer`, `better-sqlite3`, `class-variance-authority`, `clsx`, `dotenv`, `express-session`, `lucide-react`, `@modelcontextprotocol/sdk`, `next`, `express`, `@radix-ui/react-slot`, `razorpay`, `react`, `react-dom`, `@simplewebauthn/server`, `tailwind-merge`, `tailwindcss`, `@types/node`, `@types/react`, `@types/react-dom`, `typescript`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `createMerchantTools()` connect `createMerchantTools` to `mcpMerchantTools.test.js`, `src/server.js`, `sharedAuditLog`, `test2_debug.js`, `test2.js`, `merchantClient.js`, `adversarial-judge-repro.test.js`, `test2_loop.js`, `humanAuthorizationBoundary.test.js`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `sweepExpiredCarts()` connect `razorpayClient.js` to `db.js`, `webhooks.js`, `checkout.js`, `velocityTracker.js`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `createMerchantTools()` (e.g. with `merchantClient.js` and `cancel_checkout()`) actually correct?**
  _`createMerchantTools()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `fix_test.sh script`, `fix_tests.sh script`, `crypto` to the rest of the system?**
  _556 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `mcpMerchantTools.test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06028368794326241 - nodes in this community are weakly interconnected._
- **Should `intent-mandate.schema.json` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._