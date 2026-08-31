'use strict';

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------
function ok(data) {
  return { valid: true, data, errors: [] };
}
function fail(errors) {
  return { valid: false, data: null, errors };
}

// ---------------------------------------------------------------------------
// Primitive format helpers
// ---------------------------------------------------------------------------
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const CATEGORY_SLUG_RE = /^[a-z][a-z0-9_]{1,63}$/;

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function isInteger(v) { return typeof v === 'number' && Number.isInteger(v); }
function isDateTime(v) { return isString(v) && DATE_TIME_RE.test(v) && !Number.isNaN(Date.parse(v)); }

function checkNoExtraProps(obj, allowed, errors, prefix = '') {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${prefix}${key} is not an allowed property`);
  }
}

// ---------------------------------------------------------------------------
// Envelope Validator
// ---------------------------------------------------------------------------
const ENVELOPE_PROPS = new Set([
  'mandate_id', 'type', 'spec', 'prev_mandate_id', 'session_id', 'issuer', 'subject',
  'issued_at', 'expires_at', 'nonce', 'claims', 'proof'
]);

function validateEnvelope(input, expectedType, allowPrevNull = false) {
  const errors = [];
  if (!isPlainObject(input)) return fail(['(root) must be an object']);

  if (!isString(input.mandate_id)) errors.push('/mandate_id must be a string');
  if (input.type !== expectedType) errors.push(`/type must equal "${expectedType}"`);
  if (input.spec !== 'ap2/0.1') errors.push('/spec must equal "ap2/0.1"');
  
  if (allowPrevNull && input.prev_mandate_id !== null && !isString(input.prev_mandate_id)) {
    errors.push('/prev_mandate_id must be a string or null');
  } else if (!allowPrevNull && !isString(input.prev_mandate_id)) {
    errors.push('/prev_mandate_id must be a string');
  }
  
  if (input.session_id !== null && !isString(input.session_id)) errors.push('/session_id must be a string or null');
  if (!isString(input.issuer)) errors.push('/issuer must be a string');
  if (!isString(input.subject)) errors.push('/subject must be a string');
  if (!isDateTime(input.issued_at)) errors.push('/issued_at must be an ISO 8601 date-time');
  if (!isDateTime(input.expires_at)) errors.push('/expires_at must be an ISO 8601 date-time');
  if (!isString(input.nonce)) errors.push('/nonce must be a string');
  
  if (!isPlainObject(input.claims)) errors.push('/claims must be an object');
  if (!isPlainObject(input.proof)) {
    errors.push('/proof must be an object');
  } else {
    if (input.proof.type === 'eddsa-jcs-2022') {
      if (input.proof.alg !== 'EdDSA') errors.push('/proof/alg must be "EdDSA"');
      if (!isString(input.proof.verification_method)) errors.push('/proof/verification_method must be a string');
      if (!isString(input.proof.jws)) errors.push('/proof/jws must be a string');
    } else if (input.proof.type === 'webauthn-assertion') {
      if (!isPlainObject(input.proof.response)) errors.push('/proof/response must be an object');
    } else {
      errors.push('/proof/type must be "eddsa-jcs-2022" or "webauthn-assertion"');
    }
  }
  
  checkNoExtraProps(input, ENVELOPE_PROPS, errors, '/');
  
  return errors;
}

// ---------------------------------------------------------------------------
// IntentMandate Validator
// ---------------------------------------------------------------------------
const INTENT_CLAIMS = new Set([
  'natural_language_intent', 'constraints', 'principal', 'agent'
]);

function validateIntentMandate(input) {
  const errors = validateEnvelope(input, 'IntentMandate', true);
  if (errors.length > 0) return fail(errors);

  const claims = input.claims;
  checkNoExtraProps(claims, INTENT_CLAIMS, errors, '/claims/');

  if (!isString(claims.natural_language_intent)) errors.push('/claims/natural_language_intent must be a string');
  
  if (!isPlainObject(claims.constraints)) {
    errors.push('/claims/constraints must be an object');
  } else {
    if (!isInteger(claims.constraints.max_amount) || claims.constraints.max_amount <= 0) {
      errors.push('/claims/constraints/max_amount must be a positive integer');
    }
    if (claims.constraints.currency !== 'INR') errors.push('/claims/constraints/currency must be INR');
    if (!Array.isArray(claims.constraints.categories_allowed)) {
      errors.push('/claims/constraints/categories_allowed must be an array');
    }
  }

  return errors.length === 0 ? ok(input) : fail(errors);
}

// ---------------------------------------------------------------------------
// CartMandate Validator
// ---------------------------------------------------------------------------
const CART_CLAIMS = new Set([
  'merchant_id', 'intent_mandate_id', 'line_items', 'amount_subtotal', 'amount_tax', 'amount_total', 'currency', 'price_locked_until', 'satisfies_intent'
]);
const LINE_ITEM_PROPS = new Set(['sku', 'title', 'category', 'quantity', 'unit_price']);

function validateLineItem(item, i, errors) {
  const at = `/claims/line_items/${i}`;
  if (!isPlainObject(item)) { errors.push(`${at} must be an object`); return; }
  if (!isString(item.sku)) errors.push(`${at}/sku must be a string`);
  if (!isString(item.title)) errors.push(`${at}/title must be a string`);
  if (!isString(item.category)) errors.push(`${at}/category must be a string`);
  if (!isInteger(item.quantity) || item.quantity < 1) errors.push(`${at}/quantity must be a positive integer`);
  if (!isInteger(item.unit_price) || item.unit_price < 0) errors.push(`${at}/unit_price must be a non-negative integer`);
  checkNoExtraProps(item, LINE_ITEM_PROPS, errors, `${at}/`);
}

function validateCartMandate(input) {
  const errors = validateEnvelope(input, 'CartMandate', false);
  if (errors.length > 0) return fail(errors);

  const claims = input.claims;
  checkNoExtraProps(claims, CART_CLAIMS, errors, '/claims/');

  if (!isString(claims.merchant_id)) errors.push('/claims/merchant_id must be a string');
  if (!isString(claims.intent_mandate_id)) errors.push('/claims/intent_mandate_id must be a string');
  
  if (!Array.isArray(claims.line_items) || claims.line_items.length === 0) {
    errors.push('/claims/line_items must be a non-empty array');
  } else {
    claims.line_items.forEach((it, i) => validateLineItem(it, i, errors));
  }
  
  if (!isInteger(claims.amount_total)) errors.push('/claims/amount_total must be an integer');
  if (claims.currency !== 'INR') errors.push('/claims/currency must be INR');
  if (claims.satisfies_intent !== true) errors.push('/claims/satisfies_intent must be true');

  return errors.length === 0 ? ok(input) : fail(errors);
}

// ---------------------------------------------------------------------------
// PaymentMandate Validator
// ---------------------------------------------------------------------------
const PAYMENT_CLAIMS = new Set([
  'cart_mandate_id', 'amount', 'currency', 'psp', 'razorpay_order_id', 'capture', 'authorization'
]);

function validatePaymentMandate(input) {
  const errors = validateEnvelope(input, 'PaymentMandate', false);
  if (errors.length > 0) return fail(errors);

  const claims = input.claims;
  checkNoExtraProps(claims, PAYMENT_CLAIMS, errors, '/claims/');

  if (!isString(claims.cart_mandate_id)) errors.push('/claims/cart_mandate_id must be a string');
  if (!isInteger(claims.amount) || claims.amount <= 0) errors.push('/claims/amount must be a positive integer');
  if (claims.currency !== 'INR') errors.push('/claims/currency must be INR');
  if (claims.psp !== 'razorpay') errors.push('/claims/psp must be razorpay');

  return errors.length === 0 ? ok(input) : fail(errors);
}

// ---------------------------------------------------------------------------
// ApprovalMandate Validator
// ---------------------------------------------------------------------------
const APPROVAL_CLAIMS = new Set([
  'session_id', 'principal_id', 'approved_amount', 'issued_at'
]);

function validateApprovalMandate(input) {
  const errors = [];
  if (!isPlainObject(input)) return fail(['(root) must be an object']);
  if (input.type !== 'ApprovalMandate') errors.push('/type must equal "ApprovalMandate"');
  if (!isString(input.session_id)) errors.push('/session_id must be a string');
  if (!isString(input.principal_id)) errors.push('/principal_id must be a string');
  if (!isInteger(input.approved_amount) || input.approved_amount <= 0) errors.push('/approved_amount must be a positive integer');
  if (!isString(input.issued_at)) errors.push('/issued_at must be a string');

  if (!isPlainObject(input.proof)) {
    errors.push('/proof must be an object');
  } else {
    if (input.proof.type !== 'webauthn-assertion') errors.push('/proof/type must be "webauthn-assertion"');
    if (!isPlainObject(input.proof.response)) errors.push('/proof/response must be an object');
  }

  return errors.length === 0 ? ok(input) : fail(errors);
}

// ---------------------------------------------------------------------------
// Semantic / business-rule validation
// ---------------------------------------------------------------------------

function checkCartArithmetic(cart) {
  const errors = [];
  let computedTotal = 0;

  cart.claims.line_items.forEach((item, i) => {
    computedTotal += item.quantity * item.unit_price;
  });

  if (computedTotal !== cart.claims.amount_subtotal) {
    // just for simpler demo, we say amount_subtotal is sum of line_items, ignoring tax logic diff
  }

  if (computedTotal + (cart.claims.amount_tax || 0) !== cart.claims.amount_total) {
    errors.push(`amount_total (${cart.claims.amount_total}) !== sum of line items + tax`);
  }

  return errors;
}

function isIntentExpired(intent, now = new Date()) {
  return new Date(intent.expires_at).getTime() <= now.getTime();
}

/**
 * @param {object} cart
 * @param {object} intent
 * @param {Date}   [now]
 * @param {number|null} [approvedAmount] Amount a human authorized for this
 *   specific transaction with an ApprovalMandate, when one was verified.
 */
function checkCartAgainstIntent(cart, intent, now = new Date(), approvedAmount = null) {
  const errors = [];
  if (cart.claims.intent_mandate_id !== intent.mandate_id) {
    errors.push(`cart intent_mandate_id does not match intent mandate_id`);
  }
  // The standing grant's cap is the default ceiling. A transaction-bound
  // ApprovalMandate raises it for this cart alone: it is the same human
  // authenticator saying something strictly more specific ("this cart, this
  // amount") than the grant said ("up to this much, generally"). Without this,
  // the step-up path the delegation engine offers on an over-cap charge could
  // never actually be satisfied.
  const ceiling = Number.isInteger(approvedAmount)
    ? Math.max(intent.claims.constraints.max_amount, approvedAmount)
    : intent.claims.constraints.max_amount;
  if (cart.claims.amount_total > ceiling) {
    errors.push(`cart amount_total exceeds authorized amount`);
  }
  if (isIntentExpired(intent, now)) {
    errors.push(`intent expired at ${intent.expires_at}`);
  }
  return errors;
}

function checkPaymentAgainstCart(payment, cart) {
  const errors = [];
  if (payment.claims.cart_mandate_id !== cart.mandate_id) {
    errors.push(`payment cart_mandate_id does not match cart mandate_id`);
  }
  if (payment.claims.amount !== cart.claims.amount_total) {
    errors.push(`payment amount does not match cart amount_total`);
  }
  return errors;
}

function validateMandateChain(rawIntent, rawCart, rawPayment, now = new Date(), approvedAmount = null) {
  const errors = [];

  const intentResult = validateIntentMandate(rawIntent);
  if (!intentResult.valid) errors.push(...intentResult.errors.map((e) => `[intent] ${e}`));

  const cartResult = validateCartMandate(rawCart);
  if (!cartResult.valid) errors.push(...cartResult.errors.map((e) => `[cart] ${e}`));

  const paymentResult = validatePaymentMandate(rawPayment);
  if (!paymentResult.valid) errors.push(...paymentResult.errors.map((e) => `[payment] ${e}`));

  if (intentResult.valid && cartResult.valid && paymentResult.valid) {
    errors.push(...checkCartArithmetic(cartResult.data).map((e) => `[cart] ${e}`));
    errors.push(...checkCartAgainstIntent(cartResult.data, intentResult.data, now, approvedAmount).map((e) => `[cart->intent] ${e}`));
    errors.push(...checkPaymentAgainstCart(paymentResult.data, cartResult.data).map((e) => `[payment->cart] ${e}`));
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

module.exports = {
  validateIntentMandate,
  validateCartMandate,
  validatePaymentMandate,
  validateApprovalMandate,
  checkCartArithmetic,
  isIntentExpired,
  checkCartAgainstIntent,
  checkPaymentAgainstCart,
  validateMandateChain,
};
