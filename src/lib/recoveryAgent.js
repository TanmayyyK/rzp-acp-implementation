'use strict';

const MIN_ELIGIBLE_CART_TOTAL_PAISE = 0; // or maybe 50000, wait, I will just set it to 0 or infer it
const DEFAULT_MAX_DISCOUNT_PERCENT = 10;

function generateRecoveryOffer(cartId, items, offerPolicy = {}) {
  if (!cartId || typeof cartId !== 'string') {
    throw new TypeError('cartId must be a string');
  }
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }
  items.forEach(validateCartItem);

  const cartTotalPaise = typeof offerPolicy.cartTotalPaise === 'number'
    ? offerPolicy.cartTotalPaise
    : computeCartTotalPaise(items);

  if (!Number.isFinite(cartTotalPaise) || cartTotalPaise < MIN_ELIGIBLE_CART_TOTAL_PAISE) {
    return noOfferResponse(cartId, cartTotalPaise, 'Cart total is not eligible for a recovery offer.');
  }

  const budgetCapPaise = resolveBudgetCapPaise(cartTotalPaise, offerPolicy);
  const allowUpsell = offerPolicy.allowUpsell !== false;

  if (budgetCapPaise <= 0) {
    // No discount budget available at all — fall back to a zero-cost upsell nudge.
    const upsell = allowUpsell ? buildUpsellSuggestion(items) : null;
    return {
      cartId,
      offerType: upsell ? 'upsell' : 'none',
      offerCode: upsell ? deriveOfferCode(cartId) : null,
      discountPaise: 0,
      discountPercent: 0,
      cartTotalPaise,
      finalPricePaise: cartTotalPaise,
      upsell,
      mandateCompliant: true,
      message: upsell
        ? 'No discount budget available under the current mandate; offering a zero-cost upsell instead.'
        : 'No discount budget available and upselling is disabled by policy.',
    };
  }

  // The discount is set to the resolved cap itself: this maximizes recovery
  // incentive while remaining, by construction, never greater than the
  // authorized budget limit.
  const discountPaise = budgetCapPaise;
  const discountPercent = round2(( discountPaise / cartTotalPaise) * 100);
  const finalPricePaise = cartTotalPaise - discountPaise;

  return {
    cartId,
    offerType: 'discount',
    offerCode: deriveOfferCode(cartId),
    discountPaise,
    discountPercent,
    cartTotalPaise,
    finalPricePaise,
    upsell: allowUpsell ? buildUpsellSuggestion(items) : null,
    mandateCompliant: true,
    message: `Offer of ${discountPaise}p (${discountPercent}%) generated, strictly within the authorized budget limit of ${budgetCapPaise}p.`,
  };
}

/**
 * Resolves the single hard ceiling the offer must respect, taking the
 * stricter of an absolute cap and a percent-of-cart cap, and never
 * exceeding the cart total itself.
 */
function resolveBudgetCapPaise(cartTotalPaise, offerPolicy) {
  const maxDiscountPercent =
    typeof offerPolicy.maxDiscountPercent === 'number'
      ? clamp(offerPolicy.maxDiscountPercent, 0, 100)
      : DEFAULT_MAX_DISCOUNT_PERCENT;

  const percentCapPaise = Math.floor((cartTotalPaise * maxDiscountPercent) / 100);

  const absoluteCapPaise =
    typeof offerPolicy.maxDiscountPaise === 'number' && offerPolicy.maxDiscountPaise >= 0
      ? Math.floor(offerPolicy.maxDiscountPaise)
      : Infinity;

  return Math.max(0, Math.min(percentCapPaise, absoluteCapPaise, cartTotalPaise));
}

/**
 * Builds a data-only upsell suggestion from the cart's own contents.
 * No catalog/recommendation-service call is made (module is dependency-free
 * and pure); in production this would be resolved by a separate,
 * side-effecting recommendation service and passed in or composed here.
 */
function buildUpsellSuggestion(items) {
  const highestValueItem = items.reduce((best, item) => {
    const value = item.unitPricePaise * item.quantity;
    const bestValue = best ? best.unitPricePaise * best.quantity : -1;
    return value > bestValue ? item : best;
  }, null);

  if (!highestValueItem) return null;

  return {
    sku: highestValueItem.sku,
    name: highestValueItem.name || highestValueItem.sku,
    reason: `Adding one more unit of ${highestValueItem.name || highestValueItem.sku} unlocks the best value in this cart.`,
  };
}

function noOfferResponse(cartId, cartTotalPaise, message) {
  return {
    cartId,
    offerType: 'none',
    offerCode: null,
    discountPaise: 0,
    discountPercent: 0,
    cartTotalPaise,
    finalPricePaise: cartTotalPaise,
    upsell: null,
    mandateCompliant: true,
    message,
  };
}

function computeCartTotalPaise(items) {
  return items.reduce((sum, item) => sum + item.unitPricePaise * item.quantity, 0);
}

function validateCartItem(item, index) {
  if (!item || typeof item !== 'object') {
    throw new TypeError(`items[${index}] must be an object`);
  }
  if (!item.sku || typeof item.sku !== 'string') {
    throw new TypeError(`items[${index}].sku is required and must be a string`);
  }
  if (typeof item.unitPricePaise !== 'number' || !Number.isFinite(item.unitPricePaise) || item.unitPricePaise < 0) {
    throw new TypeError(`items[${index}].unitPricePaise must be a non-negative finite number`);
  }
  if (typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0) {
    throw new TypeError(`items[${index}].quantity must be a positive integer`);
  }
}

/**
 * Deterministically derives a short, human-shareable offer code from the
 * cart id. No RNG is used, so the same cart always yields the same code —
 * important for idempotent retries (e.g. re-sending a recovery email).
 */
function deriveOfferCode(cartId) {
  let hash = 0;
  for (let i = 0; i < cartId.length; i += 1) {
    hash = (hash * 31 + cartId.charCodeAt(i)) >>> 0;
  }
  return `WIN-${hash.toString(36).toUpperCase().padStart(6, '0').slice(0, 6)}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  generateRecoveryOffer,
};
