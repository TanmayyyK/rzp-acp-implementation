const { isValidIdempotencyKey } = require('../src/lib/razorpayIdempotencyWrapper');

describe('isValidIdempotencyKey', () => {
  test.each([
    ['too short', 'abc', false],
    ['valid uuid-based key', `idem_${'a'.repeat(20)}`, true],
    ['non-string input', 12345, false],
    ['contains invalid characters', 'idem_$$$invalid$$$', false],
  ])('%s', (_label, input, expected) => {
    expect(isValidIdempotencyKey(input)).toBe(expected);
  });
});
