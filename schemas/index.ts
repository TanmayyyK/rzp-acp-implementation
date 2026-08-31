import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import intentSchema from "../../schemas/intent-mandate.schema.json";
import cartSchema from "../../schemas/cart-mandate.schema.json";
import paymentSchema from "../../schemas/payment-mandate.schema.json";

import type {
  IntentMandate,
  CartMandate,
  PaymentMandate,
} from "../types/mandates";

// ---------------------------------------------------------------------------
// Ajv setup
// ---------------------------------------------------------------------------

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictSchema: true,
});
addFormats(ajv);

const compiledIntent: ValidateFunction<IntentMandate> = ajv.compile(intentSchema);
const compiledCart: ValidateFunction<CartMandate> = ajv.compile(cartSchema);
const compiledPayment: ValidateFunction<PaymentMandate> = ajv.compile(paymentSchema);

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { valid: true; data: T; errors: [] }
  | { valid: false; data: null; errors: string[] };

function formatAjvErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((e) => {
    const path = e.instancePath || "(root)";
    return `${path} ${e.message ?? "is invalid"}`.trim();
  });
}

function ok<T>(data: T): ValidationResult<T> {
  return { valid: true, data, errors: [] };
}

function fail<T>(errors: string[]): ValidationResult<T> {
  return { valid: false, data: null, errors };
}

// ---------------------------------------------------------------------------
// Structural (schema) validation
// ---------------------------------------------------------------------------

export function validateIntentMandate(input: unknown): ValidationResult<IntentMandate> {
  if (compiledIntent(input)) return ok(input as IntentMandate);
  return fail(formatAjvErrors(compiledIntent));
}

export function validateCartMandate(input: unknown): ValidationResult<CartMandate> {
  if (compiledCart(input)) return ok(input as CartMandate);
  return fail(formatAjvErrors(compiledCart));
}

export function validatePaymentMandate(input: unknown): ValidationResult<PaymentMandate> {
  if (compiledPayment(input)) return ok(input as PaymentMandate);
  return fail(formatAjvErrors(compiledPayment));
}

// ---------------------------------------------------------------------------
// Semantic / business-rule validation
// JSON Schema alone can't express cross-field arithmetic or cross-mandate
// relationships, so these run after structural validation succeeds.
// ---------------------------------------------------------------------------

/** Verifies each line item's total and the cart's grand total add up correctly. */
export function checkCartArithmetic(cart: CartMandate): string[] {
  const errors: string[] = [];
  let computedTotal = 0;

  for (const [i, item] of cart.line_items.entries()) {
    const expectedLineTotal = item.quantity * item.unit_price_paise;
    if (item.line_total_paise !== expectedLineTotal) {
      errors.push(
        `line_items[${i}] line_total_paise (${item.line_total_paise}) !== quantity * unit_price_paise (${expectedLineTotal})`
      );
    }
    computedTotal += item.line_total_paise;
  }

  if (computedTotal !== cart.total_paise) {
    errors.push(
      `total_paise (${cart.total_paise}) !== sum of line_total_paise (${computedTotal})`
    );
  }

  return errors;
}

/** Checks whether an IntentMandate's expiry has passed relative to `now`. */
export function isIntentExpired(intent: IntentMandate, now: Date = new Date()): boolean {
  return new Date(intent.expiry_timestamp).getTime() <= now.getTime();
}

/** Verifies a CartMandate was legally built under the given IntentMandate. */
export function checkCartAgainstIntent(
  cart: CartMandate,
  intent: IntentMandate,
  now: Date = new Date()
): string[] {
  const errors: string[] = [];

  if (cart.intent_reference !== intent.intent_id) {
    errors.push(
      `cart.intent_reference (${cart.intent_reference}) does not match intent.intent_id (${intent.intent_id})`
    );
  }
  if (cart.total_paise > intent.max_paise) {
    errors.push(
      `cart.total_paise (${cart.total_paise}) exceeds intent.max_paise (${intent.max_paise})`
    );
  }
  if (isIntentExpired(intent, now)) {
    errors.push(`intent ${intent.intent_id} expired at ${intent.expiry_timestamp}`);
  }

  return errors;
}

/** Verifies a PaymentMandate legally settles the given CartMandate. */
export function checkPaymentAgainstCart(payment: PaymentMandate, cart: CartMandate): string[] {
  const errors: string[] = [];

  if (payment.cart_id !== cart.cart_id) {
    errors.push(`payment.cart_id (${payment.cart_id}) does not match cart.cart_id (${cart.cart_id})`);
  }
  if (payment.intent_reference !== cart.intent_reference) {
    errors.push(
      `payment.intent_reference (${payment.intent_reference}) does not match cart.intent_reference (${cart.intent_reference})`
    );
  }
  if (payment.final_paise !== cart.total_paise) {
    errors.push(
      `payment.final_paise (${payment.final_paise}) does not match cart.total_paise (${cart.total_paise})`
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Full-chain convenience validator
// ---------------------------------------------------------------------------

export type ChainValidationResult =
  | { valid: true; errors: [] }
  | { valid: false; errors: string[] };

/**
 * Validates raw, untyped intent/cart/payment payloads structurally against
 * their schemas, then checks that they form a legally consistent mandate
 * chain (intent -> cart -> payment).
 */
export function validateMandateChain(
  rawIntent: unknown,
  rawCart: unknown,
  rawPayment: unknown,
  now: Date = new Date()
): ChainValidationResult {
  const errors: string[] = [];

  const intentResult = validateIntentMandate(rawIntent);
  if (!intentResult.valid) errors.push(...intentResult.errors.map((e) => `[intent] ${e}`));

  const cartResult = validateCartMandate(rawCart);
  if (!cartResult.valid) errors.push(...cartResult.errors.map((e) => `[cart] ${e}`));

  const paymentResult = validatePaymentMandate(rawPayment);
  if (!paymentResult.valid) errors.push(...paymentResult.errors.map((e) => `[payment] ${e}`));

  // Only run semantic checks once all three pass structural validation.
  if (intentResult.valid && cartResult.valid && paymentResult.valid) {
    errors.push(...checkCartArithmetic(cartResult.data).map((e) => `[cart] ${e}`));
    errors.push(
      ...checkCartAgainstIntent(cartResult.data, intentResult.data, now).map((e) => `[cart->intent] ${e}`)
    );
    errors.push(
      ...checkPaymentAgainstCart(paymentResult.data, cartResult.data).map((e) => `[payment->cart] ${e}`)
    );
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}
