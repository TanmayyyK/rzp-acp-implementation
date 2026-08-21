const {
  createIdempotencyWrapper,
  generateIdempotencyKey,
  isValidIdempotencyKey,
  isNetworkError,
  IdempotencyKeyError,
  RazorpayRequestError,
} = require('../src/razorpayIdempotencyWrapper');

describe('generateIdempotencyKey', () => {
  test('produces keys that pass isValidIdempotencyKey', () => {
    const key = generateIdempotencyKey('order');
    expect(isValidIdempotencyKey(key)).toBe(true);
    expect(key.startsWith('order_')).toBe(true);
  });

  test('produces unique keys on each call', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  test('throws a TypeError for an empty prefix', () => {
    expect(() => generateIdempotencyKey('')).toThrow(TypeError);
  });
});

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

describe('isNetworkError', () => {
  test('recognizes known network error codes', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' });
    expect(isNetworkError(err)).toBe(true);
  });

  test('recognizes AbortError by name', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isNetworkError(err)).toBe(true);
  });

  test('returns false for a plain validation error', () => {
    expect(isNetworkError(new Error('Invalid amount'))).toBe(false);
  });

  test('returns false for null or undefined', () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});

describe('createIdempotencyWrapper().execute', () => {
  let wrapper;

  beforeEach(() => {
    wrapper = createIdempotencyWrapper();
  });

  test('calls requestFn and caches the response on success', async () => {
    const requestFn = jest.fn().mockResolvedValue({ id: 'pay_1', status: 'captured' });
    const key = wrapper.generateIdempotencyKey('order');

    const result = await wrapper.execute(key, requestFn);

    expect(result).toEqual({ id: 'pay_1', status: 'captured' });
    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(wrapper.getStatus(key)).toBe('success');
  });

  test('returns the cached response on a repeated key without calling Razorpay again', async () => {
    const requestFn = jest.fn().mockResolvedValue({ id: 'pay_2' });
    const key = wrapper.generateIdempotencyKey('order');

    const first = await wrapper.execute(key, requestFn);
    const second = await wrapper.execute(key, requestFn);

    expect(first).toEqual({ id: 'pay_2' });
    expect(second).toEqual({ id: 'pay_2' });
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  test('dedupes concurrent calls that share the same in-flight key', async () => {
    let resolveRequest;
    const requestFn = jest.fn(
      () => new Promise((resolve) => { resolveRequest = resolve; })
    );
    const key = wrapper.generateIdempotencyKey('order');

    const p1 = wrapper.execute(key, requestFn);
    const p2 = wrapper.execute(key, requestFn);

    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(wrapper.getStatus(key)).toBe('in_progress');

    resolveRequest({ id: 'pay_3' });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual({ id: 'pay_3' });
    expect(r2).toBe(r1);
  });

  test('on a network error, clears the entry so a retry with the same key tries again', async () => {
    const networkErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const requestFn = jest
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce({ id: 'pay_4' });
    const key = wrapper.generateIdempotencyKey('order');

    await expect(wrapper.execute(key, requestFn)).rejects.toMatchObject({
      name: 'RazorpayRequestError',
      retryable: true,
    });
    expect(wrapper.getStatus(key)).toBeUndefined();

    const result = await wrapper.execute(key, requestFn);

    expect(result).toEqual({ id: 'pay_4' });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  test('on a non-network error, records a failed status but still allows a retry', async () => {
    const validationErr = new Error('Invalid amount');
    const requestFn = jest
      .fn()
      .mockRejectedValueOnce(validationErr)
      .mockResolvedValueOnce({ id: 'pay_5' });
    const key = wrapper.generateIdempotencyKey('order');

    await expect(wrapper.execute(key, requestFn)).rejects.toMatchObject({
      name: 'RazorpayRequestError',
      retryable: false,
    });
    expect(wrapper.getStatus(key)).toBe('failed');

    const result = await wrapper.execute(key, requestFn);

    expect(result).toEqual({ id: 'pay_5' });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  test('rejects with IdempotencyKeyError for a malformed key, without calling requestFn', async () => {
    const requestFn = jest.fn();

    await expect(wrapper.execute('too-short', requestFn)).rejects.toThrow(IdempotencyKeyError);
    expect(requestFn).not.toHaveBeenCalled();
  });

  test('rejects with TypeError when requestFn is not a function', async () => {
    const key = wrapper.generateIdempotencyKey('order');
    await expect(wrapper.execute(key, 'not-a-function')).rejects.toThrow(TypeError);
  });

  test('clear() empties the cache and size() reports the entry count', async () => {
    const key = wrapper.generateIdempotencyKey('order');
    await wrapper.execute(key, jest.fn().mockResolvedValue('ok'));

    expect(wrapper.size()).toBe(1);

    wrapper.clear();

    expect(wrapper.size()).toBe(0);
    expect(wrapper.getStatus(key)).toBeUndefined();
  });

  test('each wrapper instance has an isolated cache', async () => {
    const wrapperA = createIdempotencyWrapper();
    const wrapperB = createIdempotencyWrapper();
    const key = generateIdempotencyKey('order');

    await wrapperA.execute(key, jest.fn().mockResolvedValue('from-a'));

    expect(wrapperA.getStatus(key)).toBe('success');
    expect(wrapperB.getStatus(key)).toBeUndefined();
  });
});
