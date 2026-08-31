# Graph Report - RazorPay (2026-08-31 - Final Gateway Update)

## Summary
- 816 nodes · 1205 edges · 46 communities
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS
- Multi-Protocol Architecture: ACP + AP2 + x402 Unified Protocol Settlement Rails
- Trust Engine: Agent Circle WebAuthn + Delegation Engine + Server-Side Velocity Guardrails

## Graph Freshness
- Built from commit: `f8a29b4` (Latest Multi-Protocol Gateway)
- Fresh snapshot generated on: 2026-08-31

## Core Abstractions & God Nodes
1. `createMerchantTools()` - MCP air-gapped tool execution surface
2. `POST /x402/submit` - Multi-Protocol Trust Core Funnel for x402
3. `translateToInternalMandate()` - x402 / AP2 unified mandate translation
4. `evaluateDelegation()` - Agent Circle delegation engine ('full' vs 'partial')
5. `checkVelocity()` & `recordSpend()` - Sliding-window spend cap keyed strictly to principal_id
6. `validateMandateChain()` - W3C VC EdDSA cryptographic verification
7. `transitionSession()` - State machine for ACP checkout session lifecycle
8. `generateRecoveryOffer()` - Autonomous cart abandonment recovery agent
9. `verifyChain()` - Tamper-evident hash-chained cryptographic audit log

## Protocol & Architecture Communities
- Community 0: "src/routes/x402.js" & "src/adapters/x402Adapter.js" (x402 Express router & HTTP 402 mandate translation)
- Community 1: "src/lib/delegation.js" (Agent Circle bounded authority delegation engine)
- Community 2: "src/lib/recoveryAgent.js" (Cart recovery agent with mandate-compliant upsell generation)
- Community 3: "src/lib/velocityTracker.js" (In-memory sliding window velocity ledger keyed by principal)
- Community 4: "src/circle/webauthn.js" (FIDO2 / SimpleWebAuthn biometric authentication ceremony)
- Community 5: "src/routes/checkout.js" (5-stage ACP session state machine & Razorpay order settlement)
- Community 6: "src/lib/auditLog.js" (Append-only SHA-256 JCS hash-chained audit engine)
- Community 7: "src/server.js" (Application Composition Root & Express Routing)
