const { getMockProductFeed, rupeesToPaise } = require('../src/lib/mockProductFeed');

describe('rupeesToPaise', () => {
  test('converts whole rupees to paise', () => {
    expect(rupeesToPaise(1799)).toBe(179900);
  });

  test('converts fractional rupees to paise and rounds to an integer', () => {
    expect(rupeesToPaise(19.995)).toBe(2000); // rounds 1999.5 -> 2000
  });

  test('throws a TypeError for negative amounts', () => {
    expect(() => rupeesToPaise(-5)).toThrow(TypeError);
  });

  test('throws a TypeError for non-numeric input', () => {
    expect(() => rupeesToPaise('1799')).toThrow(TypeError);
  });
});

describe('getMockProductFeed', () => {
  const feed = getMockProductFeed();

  test('returns an array of exactly 3 products', () => {
    expect(Array.isArray(feed)).toBe(true);
    expect(feed).toHaveLength(3);
  });

  test('returns a frozen (immutable) array', () => {
    expect(Object.isFrozen(feed)).toBe(true);
  });

  test('is purely functional: repeated calls return equal but distinct arrays', () => {
    const otherFeed = getMockProductFeed();
    expect(otherFeed).toEqual(feed);
    expect(otherFeed).not.toBe(feed);
  });

  test.each(getMockProductFeed())(
    'product "$id" matches the expected ACP shape',
    (product) => {
      expect(typeof product.id).toBe('string');
      expect(product.id.length).toBeGreaterThan(0);

      expect(typeof product.title).toBe('string');
      expect(product.title.length).toBeGreaterThan(0);

      expect(typeof product.description).toBe('string');
      expect(product.description.length).toBeGreaterThan(0);

      expect(Number.isInteger(product.price)).toBe(true);
      expect(product.price).toBeGreaterThan(0);

      expect(product.currency).toBe('INR');

      expect(typeof product.availability).toBe('boolean');

      expect(Array.isArray(product.images)).toBe(true);
      expect(product.images.length).toBeGreaterThan(0);
      product.images.forEach((url) => {
        expect(() => new URL(url)).not.toThrow();
      });

      expect(typeof product.eligibility_rules).toBe('object');
      expect(product.eligibility_rules).not.toBeNull();
      expect(Array.isArray(product.eligibility_rules.countries)).toBe(true);

      expect(Object.isFrozen(product)).toBe(true);
      expect(Object.isFrozen(product.images)).toBe(true);
      expect(Object.isFrozen(product.eligibility_rules)).toBe(true);
    }
  );

  test('includes at least one in-stock and one out-of-stock product', () => {
    const availabilities = feed.map((p) => p.availability);
    expect(availabilities).toContain(true);
    expect(availabilities).toContain(false);
  });
});
