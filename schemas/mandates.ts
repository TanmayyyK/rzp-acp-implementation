/**
 * AP2 mandate types.
 *
 * These interfaces are hand-mirrors of the JSON Schemas in /schemas.
 * If you change a field in one, change it in the other — the validation
 * module checks data against the JSON Schemas at runtime, and these
 * interfaces only give you compile-time shape checking.
 */

/** Amount in paise (1/100 INR). Kept as a plain number; branded if you want stronger guarantees. */
export type Paise = number;

/** ISO 8601 timestamp string, e.g. "2026-08-22T10:15:00Z". */
export type ISODateTime = string;

/** RFC 4122 UUID string. */
export type UUID = string;

export type CategorySlug = string; // e.g. "electronics", "groceries"

export type PaymentMethod = "UPI" | "CARD" | "NETBANKING" | "WALLET";

// ---------------------------------------------------------------------------
// IntentMandate
// ---------------------------------------------------------------------------

export interface IntentMandate {
  mandate_type: "IntentMandate";
  intent_id: UUID;
  /** Maximum amount, in paise, this intent authorizes. */
  max_paise: Paise;
  /** Timestamp after which this intent is no longer valid. */
  expiry_timestamp: ISODateTime;
  /** Category slugs this intent may be spent against. Non-empty, unique. */
  allowed_categories: CategorySlug[];
  created_at: ISODateTime;
  /** Base64-encoded signature over the mandate payload. */
  signature?: string;
}

// ---------------------------------------------------------------------------
// CartMandate
// ---------------------------------------------------------------------------

export interface LineItem {
  sku: string;
  description: string;
  quantity: number;
  unit_price_paise: Paise;
  /** Must equal quantity * unit_price_paise. */
  line_total_paise: Paise;
  /** Line items in a CartMandate are always locked once mandated. */
  locked: true;
}

export interface CartMandate {
  mandate_type: "CartMandate";
  cart_id: UUID;
  /** intent_id of the IntentMandate this cart was built under. */
  intent_reference: UUID;
  /** Locked, price-immutable line items. */
  line_items: LineItem[];
  /** Sum of all line_total_paise values. */
  total_paise: Paise;
  created_at: ISODateTime;
  signature?: string;
}

// ---------------------------------------------------------------------------
// PaymentMandate
// ---------------------------------------------------------------------------

export interface PaymentMandate {
  mandate_type: "PaymentMandate";
  payment_id: UUID;
  /** Reference to the CartMandate.cart_id being paid for. */
  cart_id: UUID;
  /** intent_id of the originating IntentMandate. */
  intent_reference: UUID;
  /** Final authorized payment amount, in paise. Should equal the cart's total_paise. */
  final_paise: Paise;
  payment_method?: PaymentMethod;
  created_at: ISODateTime;
  signature?: string;
}

export type AP2Mandate = IntentMandate | CartMandate | PaymentMandate;
