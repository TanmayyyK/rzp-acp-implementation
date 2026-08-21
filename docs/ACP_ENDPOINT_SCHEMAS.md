# ACP Endpoint Schemas (Day 3)

This document defines the exact TypeScript interfaces for the request and response payloads of the 5 core Agent Commerce Protocol (ACP) checkout endpoints. These schemas map the standard ACP lifecycle directly to the AP2 mandate authorization chain and the Razorpay Order/Payment Link wrappers built on Day 2.

## Common Types & Models

```typescript
// Money is strictly defined as an integer in minor units (paise) per ADR-004
type Paise = number;
type ISODateTime = string; // e.g. "2026-08-21T10:15:30Z"

// The 5-stage checkout state machine (ADR-009)
type SessionState = 'CREATED' | 'CONFIRMED' | 'PAID' | 'FULFILLING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

interface LineItem {
  sku: string;
  quantity: number;
  // Included in responses, omitted in some update requests
  title?: string;
  category?: string;
  unit_price?: Paise;
}

// Opaque envelope for signed AP2 mandates
interface SignedMandate {
  mandate_id: string;
  type: 'IntentMandate' | 'CartMandate' | 'PaymentMandate';
  spec: string;
  prev_mandate_id: string | null;
  session_id: string;
  issuer: string;
  subject: string;
  issued_at: ISODateTime;
  expires_at: ISODateTime;
  nonce: string;
  claims: Record<string, any>;
  proof: {
    type: string;
    alg: string;
    verification_method: string;
    jws: string; // The EdDSA signature over the canonical JSON
  };
}
```

---

## 1. Create Checkout Session
**`POST /api/v1/checkout/sessions`**

Initializes a session by evaluating the buyer's `IntentMandate`, constructing a cart, and issuing a merchant-signed `CartMandate` locking the price.

```typescript
interface CreateSessionRequest {
  intent_mandate: SignedMandate; // Type: IntentMandate
  requested_items: LineItem[];
}

interface CreateSessionResponse {
  session_id: string; // e.g., 'acp_sess_01J8Z3K7'
  state: 'CREATED';
  cart_mandate: SignedMandate; // Type: CartMandate (signed by merchant)
  amount_total: Paise;
  currency: string;
  expires_at: ISODateTime; // Mirrors the CartMandate expiration
}
```

---

## 2. Update Checkout Session
**`PATCH /api/v1/checkout/sessions/:session_id`**

Adds or removes items from the cart. Invalidates the previous `CartMandate` and returns a newly signed one reflecting the updated totals.

```typescript
interface UpdateSessionRequest {
  requested_items: LineItem[];
}

interface UpdateSessionResponse {
  session_id: string;
  state: 'CREATED';
  cart_mandate: SignedMandate; // Re-issued with new nonce and amount
  amount_total: Paise;
  currency: string;
  expires_at: ISODateTime;
}
```

---

## 3. Get Session State
**`GET /api/v1/checkout/sessions/:session_id`**

Fetches the complete current state of the order, including the mandate chain and Razorpay identifiers. Used by the agent to verify state before proceeding or to poll for asynchronous webhook completion.

```typescript
// GET requests have no body.

interface GetSessionStateResponse {
  order_id: string; // Our internal ord_ identifier
  session_id: string;
  state: SessionState;
  amount: Paise;
  currency: string;
  line_items: LineItem[];
  
  mandate_chain: {
    intent_mandate_id: string | null;
    cart_mandate_id: string | null;
    payment_mandate_id: string | null;
  };

  razorpay: {
    order_id: string | null; // e.g., 'order_PZxYwVuTsRqPoN'
    payment_id: string | null; // Populated asynchronously via webhook
    payment_link_id: string | null;
  };

  created_at: ISODateTime;
  updated_at: ISODateTime;
  failure: {
    code: string;
    reason: string;
    stage: string;
  } | null;
}
```

---

## 4. Complete Checkout
**`POST /api/v1/checkout/sessions/:session_id/complete`**

Submits the final authorization. The server evaluates the `PaymentMandate` and guardrails. If approved, it calls the `POST /v1/orders` wrapper. If the amount exceeds the auto-approval threshold, it falls back to `POST /v1/payment_links/`.

**Headers Required:** `Idempotency-Key`

```typescript
interface CompleteCheckoutRequest {
  payment_mandate: SignedMandate; // Type: PaymentMandate (without razorpay_order_id)
}

// Responses branch based on the auto_approve_threshold

// 200 OK — Under Threshold (Auto-Approved)
interface CompleteCheckoutResponseSuccess {
  session_id: string;
  state: 'CONFIRMED';
  order: {
    order_id: string;
    razorpay_order_id: string; // The order created at Razorpay
  };
  payment_mandate_id: string;
  next: 'await_webhook'; // Agent must wait for order.paid webhook
}

// 202 Accepted — Over Threshold (Human Approval Required)
interface CompleteCheckoutResponseEscalated {
  session_id: string;
  state: 'CONFIRMED';
  approval: {
    type: 'payment_link';
    url: string; // https://rzp.io/i/xxxx
    payment_link_id: string;
  };
  next: 'await_human_then_webhook'; // Agent yields until human pays link
}
```

---

## 5. Cancel Checkout
**`POST /api/v1/checkout/sessions/:session_id/cancel`**

Aborts the session. If a Razorpay Order or Payment Link was created but not yet paid, it is voided.

```typescript
// Request body is empty

interface CancelCheckoutResponse {
  session_id: string;
  state: 'CANCELLED';
  razorpay: {
    order_id: string | null;
    status: string; // e.g., 'cancelled'
  };
}
```

---

## Global Error Schema
All 400/401/403/409/500 errors across these endpoints share a standardized shape.

```typescript
interface ErrorResponse {
  error: {
    code: string; // e.g., GUARDRAIL_SPEND_CAP_EXCEEDED, MANDATE_SIGNATURE_INVALID, NONCE_REPLAYED
    message: string;
    session_id?: string;
    retriable: boolean; // Tells the agent if backoff/retry is safe
  };
}
```
