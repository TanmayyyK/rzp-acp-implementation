'use strict';

/**
 * Mock product feed conforming to a simplified subset of the Agentic
 * Commerce Protocol (ACP) product feed schema — enough to exercise
 * pricing, availability, and eligibility logic in tests or local dev.
 * It is not a full implementation of the published ACP field set
 * (see https://agenticcommerce.dev for the complete spec).
 *
 * The module is purely functional: no shared mutable state, no I/O,
 * and every value returned is frozen so callers can't mutate the feed
 * out from under each other.
 */

/**
 * Converts a rupee amount into an integer paise value, since ACP
 * requires prices in the currency's smallest integer unit.
 *
 * @param {number} rupees - Amount in rupees, e.g. 1799 or 1799.5
 * @returns {number} Amount in paise as an integer, e.g. 179900
 */
function rupeesToPaise(rupees) {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees) || rupees < 0) {
    throw new TypeError('rupees must be a non-negative finite number');
  }
  return Math.round(rupees * 100);
}

/**
 * Builds a single immutable ACP-shaped product record.
 *
 * @param {Object} spec
 * @param {string} spec.id
 * @param {string} spec.title
 * @param {string} spec.description
 * @param {number} spec.priceInRupees - Price in rupees; converted to paise.
 * @param {boolean} spec.availability
 * @param {string[]} spec.images
 * @param {Object} spec.eligibilityRules
 * @returns {Object} Frozen product object.
 */
function buildProduct(spec) {
  const { id, title, description, priceInRupees, availability, images, eligibilityRules } = spec;

  return Object.freeze({
    id,
    title,
    description,
    price: rupeesToPaise(priceInRupees),
    currency: 'INR',
    availability,
    images: Object.freeze([...images]),
    eligibility_rules: Object.freeze({ ...eligibilityRules }),
  });
}

/**
 * Returns a mock ACP product feed of 3 realistic electronics products.
 *
 * @returns {ReadonlyArray<Object>} Frozen array of 3 frozen product objects.
 */
function getMockProductFeed() {
  return Object.freeze([
    buildProduct({
      id: 'prod_electronics_001',
      title: 'Boult Audio Z40 Wireless Bluetooth Earbuds',
      description:
        'True wireless earbuds with 40 hours total playback, ENC call noise cancellation, and IPX5 sweat resistance.',
      priceInRupees: 1799,
      availability: true,
      images: [
        'https://example.com/images/boult-z40-earbuds-front.jpg',
        'https://example.com/images/boult-z40-earbuds-case.jpg',
      ],
      eligibilityRules: {
        countries: ['IN'],
        cod_eligible: true,
        max_quantity_per_order: 5,
        min_buyer_age: 18,
      },
    }),
    buildProduct({
      id: 'prod_electronics_002',
      title: 'Mi Power Bank 3i 20000mAh 18W Fast Charging',
      description:
        'High-capacity 20000mAh power bank with 18W two-way fast charging and triple-port output for phones, tablets, and earbuds.',
      priceInRupees: 1999,
      availability: true,
      images: ['https://example.com/images/mi-powerbank-3i-20000mah.jpg'],
      eligibilityRules: {
        countries: ['IN'],
        cod_eligible: false,
        max_quantity_per_order: 2,
        // Lithium-battery air shipping restrictions apply to some regions.
        restricted_shipping_regions: ['Lakshadweep'],
      },
    }),
    buildProduct({
      id: 'prod_electronics_003',
      title: 'Noise ColorFit Pulse 2 Smartwatch',
      description:
        '1.69-inch HD display smartwatch with SpO2 tracking, 60 sports modes, and up to 7 days of battery life.',
      priceInRupees: 2499,
      availability: false,
      images: [
        'https://example.com/images/noise-colorfit-pulse2-black.jpg',
        'https://example.com/images/noise-colorfit-pulse2-strap.jpg',
      ],
      eligibilityRules: {
        countries: ['IN'],
        cod_eligible: true,
        max_quantity_per_order: 3,
      },
    }),
  ]);
}

module.exports = { getMockProductFeed, rupeesToPaise };
