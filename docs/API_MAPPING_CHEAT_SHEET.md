# API Mapping & Cheat Sheet

This document maps the standardized Agent Commerce Protocol (ACP) and Agent Payments Protocol (AP2) concepts to their concrete implementations using the Razorpay API.

## 1. ACP-5 Endpoint Mapping to Razorpay

The 5 core ACP checkout lifecycle endpoints map to Razorpay objects as follows:

| ACP Endpoint | Method | Path | Razorpay Primitive | Context / Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Create Session** | `POST` | `/api/v1/checkout` | N/A (Local DB/Cache) | Initializes a cart session, generates `IntentMandate`. Does not hit Razorpay yet. |
| **Update Session** | `PATCH` | `/api/v1/checkout/{id}` | N/A (Local DB/Cache) | Adds/removes items. Generates the `CartMandate` when locked. |
| **Get State** | `GET` | `/api/v1/checkout/{id}` | N/A | Returns standard ACP JSON cart state. |
| **Complete** | `POST` | `/api/v1/checkout/{id}/complete`| `POST /v1/orders` | Converts the locked cart to a real Razorpay Order. Enforces `PaymentMandate`. Can optionally issue `POST /v1/payment_links/` if manual approval is needed. |
| **Cancel** | `POST` | `/api/v1/checkout/{id}/cancel` | `POST /v1/orders/{id}/cancel` | Aborts the transaction (if supported/applicable at the current Razorpay Order state). |

## 2. AP2-3 Mandate Authorization Chain

AP2 mandates are required at specific lifecycle stages to guarantee authorization boundaries.

| Mandate Type | Stage | Shape / Validation | Enforced By |
| :--- | :--- | :--- | :--- |
| **IntentMandate** | Create Session | Defines maximum spend, category restrictions, and expiration. | Evaluated at checkout creation; sets bounding box for the session. |
| **CartMandate** | Update Session (Lock) | Hashes specific line items and final total. Countersigned by merchant. | Evaluated before calling Razorpay to prevent bait-and-switch pricing. |
| **PaymentMandate** | Complete Checkout | Final authorization token authorizing the execution of the charge. | Required to trigger the actual `POST /v1/orders` API. |

## 3. Webhook Handling Taxonomy

| Razorpay Event | ACP State Transition | Action Required |
| :--- | :--- | :--- |
| `order.paid` | `payment_processing` ➡️ `completed` | Update local order status, emit success state, finalize audit log. |
| `payment.captured` | (Complementary to order.paid) | Fulfill order (if not relying strictly on order.paid). |
| `payment.failed` | `payment_processing` ➡️ `failed` | Update state, notify agent of failure, prompt for retry. |

## 4. Cryptographic Validation Requirements

*   **Razorpay Webhooks:** Authenticated via `x-razorpay-signature` HTTP header. Requires `crypto.createHmac('sha256')` applied to the **raw** HTTP request body.
*   **AP2 Mandates:** Authenticated via ES256 or EdDSA signatures. Validated against the Buyer Agent's public key (retrieved via Decentralized Identity / `X-Agorio-Attestation`).
