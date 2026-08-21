const crypto = require('crypto');
const { verifyRazorpaySignature } = require('../src/lib/verifyRazorpaySignature');

const SECRET = 'test_webhook_secret_123';
const RAW_BODY = JSON.stringify({
  entity: 'event',
  event: 'payment.captured',
  payload: { payment: { entity: { id: 'pay_test123', amount: 50000 } } },
});

function signBody(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyRazorpaySignature', () => {
  test('returns true for a valid signature', () => {
    const validSignature = signBody(RAW_BODY, SECRET);
    expect(verifyRazorpaySignature(RAW_BODY, validSignature, SECRET)).toBe(true);
  });

  test('returns false when the body has been tampered with', () => {
    const validSignature = signBody(RAW_BODY, SECRET);
    const tamperedBody = RAW_BODY.replace('50000', '99999');
    expect(verifyRazorpaySignature(tamperedBody, validSignature, SECRET)).toBe(false);
  });

  test('returns false when the signature is wrong', () => {
    const wrongSignature = 'a'.repeat(64); // correct length, wrong value
    expect(verifyRazorpaySignature(RAW_BODY, wrongSignature, SECRET)).toBe(false);
  });

  test('returns false when the secret used to verify does not match', () => {
    const validSignature = signBody(RAW_BODY, SECRET);
    expect(verifyRazorpaySignature(RAW_BODY, validSignature, 'wrong_secret')).toBe(false);
  });

  test('returns false when the signature has a different length than expected', () => {
    expect(verifyRazorpaySignature(RAW_BODY, 'tooshort', SECRET)).toBe(false);
  });

  test('accepts a Buffer as the raw body', () => {
    const bodyBuffer = Buffer.from(RAW_BODY, 'utf8');
    const validSignature = signBody(bodyBuffer, SECRET);
    expect(verifyRazorpaySignature(bodyBuffer, validSignature, SECRET)).toBe(true);
  });

  test('throws a TypeError when rawBody is not a string or Buffer', () => {
    expect(() => verifyRazorpaySignature({ not: 'a string' }, 'sig', SECRET)).toThrow(TypeError);
  });

  test('throws a TypeError when signature is missing or empty', () => {
    expect(() => verifyRazorpaySignature(RAW_BODY, '', SECRET)).toThrow(TypeError);
  });

  test('throws a TypeError when secret is missing or empty', () => {
    expect(() => verifyRazorpaySignature(RAW_BODY, 'sig', '')).toThrow(TypeError);
  });
});
