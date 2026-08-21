# Architecture Decision Records

Format per ADR: **Context** (the forces) → **Decision** → **Consequences** (incl. tradeoffs) → **Panel defense** (the one line you say out loud). Status of all below: **Accepted, Day 1**.

---

## ADR-001 — Merchant server and buyer agent are two independent services, joined by MCP
**Context.** "Agentic commerce" only means something if two autonomous parties transact at arm's length. If we build one monolith that both decides *and* sells, we've demoed nothing an ordinary checkout couldn't.
**Decision.** Ship a merchant ACP server and a buyer LLM agent as separate deployables. The only channel between them is a set of MCP tools (`search_catalog`, `create_cart`, `get_cart_state`, `complete_checkout`, `cancel_checkout`) that wrap the ACP REST endpoints. They are built in separate workspaces and never share in-process state.
**Consequences.** (+) The contract is forced to be explicit and inspectable; it's a genuine agent-to-agent flow. (+) MCP is the interface LLM agents natively speak, so the buyer brain stays thin. (−) A contract mismatch between the two sides is possible — mitigated by a daily facilitator diff of tool schemas vs. server routes.
**Panel defense.** *"The buyer never has privileged access to the merchant — it holds a signed mandate and calls the same public tools any agent would. That's what makes it commerce, not a script."*

---

## ADR-002 — The AP2 three-mandate chain is the authorization backbone; each party signs its own link
**Context.** A charge driven by an LLM needs a non-repudiable answer to "who authorized exactly what?" A single token can't express that the *user* set a budget, the *merchant* set a price, and *someone* approved the specific charge.
**Decision.** Model authority as an AP2 chain of three signed mandates, each a VC-shaped envelope linked by `prev_mandate_id`: **IntentMandate** signed by the buyer's WebAuthn-backed key (bounded authority), **CartMandate** signed by the merchant (locked line items + price), **PaymentMandate** signed by our merchant server *acting as the AP2 processor-of-record* (binds the cart to one Razorpay `order_id`). Signatures use **EdDSA (Ed25519) over canonical JSON (JCS)**, covering the whole envelope minus the signature.
**Consequences.** (+) Every rupee traces to three independent signatures; tampering with price or amount breaks a signature. (+) EdDSA is small, fast, and deterministic — good for detached JWS. (−) Razorpay does not sign an AP2 PaymentMandate, so *our server* signs it; we document this role explicitly rather than pretend the PSP issued it. (−) Key management (buyer key, merchant key) is now in scope.
**Panel defense.** *"Three signatures, three responsibilities: the user's cap, the merchant's price, the processor's charge. Change any of them and the math stops verifying — that's the AP2 chain doing its job."*

---

## ADR-003 — Razorpay Orders is the money primitive; Payment Links is the human-in-the-loop rail
**Context.** We need a real payment on real (test-mode) rails, a 1:1 mapping between our order and the money movement, and a way to escalate to a human without leaving the flow.
**Decision.** Each completed session creates exactly one Razorpay **Order** (1:1 with our `ord_` and the mandate chain). Auto-approved charges (≤ threshold) capture directly; charges over the threshold create a Razorpay **Payment Link** and park the session in `CONFIRMED` until a human pays. `PAID` is only ever reached from a verified webhook, never optimistically from the API response.
**Consequences.** (+) Reuses Razorpay's native idempotency and reconciliation. (+) Human-in-the-loop is a first-class, demoable path, not a bolt-on. (−) Completion is asynchronous (webhook-driven), so the API returns `CONFIRMED`, not `PAID` — the client must poll `get_cart_state` or await the webhook.
**Panel defense.** *"We never mark an order paid because our own API call returned 200 — we mark it paid when Razorpay's signed webhook says so. The source of truth for money is the rail, not our optimism."*

---

## ADR-004 — Money is an integer in minor units (paise); never a float
**Context.** Floating-point money silently corrupts totals and breaks signature/price equality checks — fatal when a signed mandate must exactly match a Razorpay amount.
**Decision.** Every amount in every model, API, and mandate is an integer number of paise. Formatting to "₹74.99" happens only at the UI edge.
**Consequences.** (+) Razorpay already expects paise, so zero conversion at the boundary. (+) Byte-exact amount equality across the mandate chain. (−) Every human-facing surface must divide by 100 — a one-line helper.
**Panel defense.** *"`749900`, not `7499.00`. Money as an integer is the difference between a signature that verifies and a rounding bug that doesn't."*

---

## ADR-005 — The audit trail is a hash-chained append-only log
**Context.** The graded bar demands an explainable, tamper-evident record of everything the agent did and every rupee it moved. A plain log file can be edited after the fact and no one can tell.
**Decision.** Append-only log where `hash = SHA256(JCS(entry − hash))` and each entry embeds the previous entry's `prev_hash`. Genesis `prev_hash` is 64 zeros. Every reasoning step, tool call, mandate issuance/verification, guardrail decision, money action, webhook, and state transition is logged. A "verify chain" walk recomputes hashes and flags the first broken link. Big blobs are stored by hash reference, not inlined.
**Consequences.** (+) Any post-hoc edit is detectable in O(n). (+) Single-writer means no consensus needed — a full blockchain would be theatre here. (−) Requires canonical serialization (JCS) to be deterministic; we pin the canonicalizer.
**Panel defense.** *"It's a miniature tamper-evident ledger: edit entry 12 and entries 12-through-now all fail verification. We can prove the audit log wasn't doctored, which is the whole point of an audit log."*

---

## ADR-006 — Guardrails are pure, server-side functions enforced at every mandate boundary (defense in depth)
**Context.** The dangerous failure is an agent that spends more, or on the wrong thing, than the user allowed. Trusting the agent to self-limit is not a control.
**Decision.** Guardrails are pure functions (spend cap, category allowlist, quantity, expiry, **single-use nonce** for replay protection, velocity) evaluated **on the server**, and evaluated **at each step of the chain**: intent constrains, the cart must satisfy the intent, the payment must satisfy the cart *and* standing policy. Over-threshold charges require human approval. Every decision is audit-logged with its inputs.
**Consequences.** (+) The agent literally cannot exceed the IntentMandate — the server refuses. (+) Layered checks catch a bad cart even if a buggy agent submits one. (−) Some duplicate validation across boundaries — deliberate, and cheap.
**Panel defense.** *"The agent proposes; the server disposes. Spend caps, allowlists, and replay protection are enforced where the agent can't reach them, and checked again at every link in the chain."*

---

## ADR-007 — Idempotency on every state-mutating call; async state only from verified webhooks
**Context.** Networks retry. An LLM may retry. A double-`complete` must never double-charge, and a duplicate webhook must never double-fulfill.
**Decision.** `POST /complete` requires an `Idempotency-Key`; the first result is stored and replayed verbatim for any repeat. Razorpay calls carry idempotency keys and are wrapped in exponential-backoff retry for 429/5xx. Webhooks are deduplicated on `event.id`. Raw request body is preserved for HMAC-SHA256 verification *before* JSON parsing (already implemented, constant-time compare).
**Consequences.** (+) Safe under retries, races, and duplicate deliveries — the buyer is never double-charged. (−) Needs a keyed store for idempotency records (in-memory for the demo, swappable for Redis/Postgres).
**Panel defense.** *"Replay the completion call, replay the webhook, hit it during a network retry — one charge, one fulfillment. That's idempotency keys plus webhook dedup doing exactly what they're for."*

---

## ADR-008 — Agent identity via attestation header bound to a WebAuthn principal
**Context.** The merchant must know *which* agent is calling and *which human* stands behind it before honoring a mandate.
**Decision.** Every agent→merchant request carries `X-Agorio-Attestation`, an HMAC-signed token binding `agent_id` to the user's `principal_id` and WebAuthn `credential_id`. It's verified before any mandate is accepted; the binding also appears inside the (separately signed) IntentMandate, so transport identity and payload identity must agree.
**Consequences.** (+) Two independent identity checks (header + signed mandate) must line up. (+) Ties the whole flow back to a real human credential. (−) Requires attestation issuance/verification plumbing on both sides.
**Panel defense.** *"We authenticate the agent at the door and again inside the signed mandate — a stolen header alone buys nothing, because it won't match the signature."*

---

## ADR-009 — The checkout state machine is the ACP 5-stage lifecycle, advanced only by legal transitions
**Context.** Ad-hoc booleans (`isPaid`, `isCancelled`) drift and permit impossible states (paid *and* cancelled).
**Decision.** One explicit state field over `CREATED → CONFIRMED → PAID → FULFILLING → COMPLETED`, with `CANCELLED`/`FAILED` terminals. Transitions are centralized and rejected if illegal (e.g. can't `complete` a `CANCELLED` session); each transition writes a `STATE_TRANSITION` audit entry.
**Consequences.** (+) The lifecycle matches ACP directly, so the discovery manifest and the code agree. (+) Impossible states are unrepresentable. (−) Slightly more ceremony than flags — worth it.
**Panel defense.** *"There's one state field and a table of allowed moves. The system can't be simultaneously paid and cancelled, and every move it made is in the audit log."*
