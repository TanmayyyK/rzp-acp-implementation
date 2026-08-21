'use strict';

/**
 * In-process regression tests for the ACP discovery endpoint and the Razorpay
 * webhook HMAC-SHA256 validation middleware.
 *
 * These drive the real Express app (src/server.js) via socketless
 * IncomingMessage/ServerResponse objects, so they run in restricted
 * environments (CI / sandboxes) that forbid binding a TCP or Unix socket.
 * No external test dependencies required — run with `npm test`.
 */

const http = require('http');
const crypto = require('crypto');
const { PassThrough } = require('stream');

const SECRET = 'test_webhook_secret_123';
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;

const app = require('../src/server.js'); // exported without a listener

// Dispatch a request straight into Express and capture the HTTP response.
function inject({ method = 'GET', url = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const reqSock = new PassThrough();
    const req = new http.IncomingMessage(reqSock);
    req.method = method;
    req.url = url;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;

    const buf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    req.headers = Object.assign({}, headers);
    if (buf) req.headers['content-length'] = String(buf.length);

    const out = new PassThrough();
    const chunks = [];
    out.on('data', (c) => chunks.push(c));

    const res = new http.ServerResponse(req);
    res.assignSocket(out);
    res.on('error', reject);
    res.on('finish', () => {
      res.detachSocket(out);
      const raw = Buffer.concat(chunks).toString('utf8');
      const statusCode = parseInt(raw.split(' ')[1], 10);
      const bodyText = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      resolve({ statusCode, bodyText });
    });

    app(req, res);
    if (buf) req.push(buf);
    req.push(null);
  });
}

const sign = (bodyBuf) => crypto.createHmac('sha256', SECRET).update(bodyBuf).digest('hex');

const WEBHOOK_URL = '/api/v1/webhooks/razorpay';
const JSON_TYPE = { 'content-type': 'application/json' };
const PAYLOAD = Buffer.from(
  '{"event":"payment.captured","id":"evt_test123","payload":{"payment":{"entity":{"id":"pay_abc"}}}}'
);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
}

(async () => {
  // ACP discovery manifest is served and self-describes protocol version.
  const disc = await inject({ method: 'GET', url: '/.well-known/acp.json' });
  let manifest = {};
  try {
    manifest = JSON.parse(disc.bodyText);
  } catch (_) {
    /* leave empty -> check fails */
  }
  check(
    'GET /.well-known/acp.json -> 200 with version 2.0',
    disc.statusCode === 200 && manifest.version === '2.0',
    `status=${disc.statusCode} version=${manifest.version}`
  );

  // Correctly signed payload is accepted.
  const valid = await inject({
    method: 'POST',
    url: WEBHOOK_URL,
    headers: Object.assign({ 'x-razorpay-signature': sign(PAYLOAD) }, JSON_TYPE),
    body: PAYLOAD,
  });
  check('valid HMAC signature -> 200', valid.statusCode === 200, `status=${valid.statusCode}`);

  // Signature valid for a different body must be rejected (raw-body integrity).
  const tampered = await inject({
    method: 'POST',
    url: WEBHOOK_URL,
    headers: Object.assign({ 'x-razorpay-signature': sign(PAYLOAD) }, JSON_TYPE),
    body: Buffer.from('{"event":"payment.captured","id":"tampered"}'),
  });
  check('tampered body with stale signature -> 400', tampered.statusCode === 400, `status=${tampered.statusCode}`);

  // Absent signature header is rejected before any crypto work.
  const missing = await inject({
    method: 'POST',
    url: WEBHOOK_URL,
    headers: JSON_TYPE,
    body: PAYLOAD,
  });
  check('missing X-Razorpay-Signature -> 400', missing.statusCode === 400, `status=${missing.statusCode}`);

  // Wrong-length signature exercises the constant-time length guard: it must
  // return 400, not 500 (crypto.timingSafeEqual throws on unequal lengths).
  const wrongLen = await inject({
    method: 'POST',
    url: WEBHOOK_URL,
    headers: Object.assign({ 'x-razorpay-signature': 'deadbeef' }, JSON_TYPE),
    body: PAYLOAD,
  });
  check('wrong-length signature -> 400 (constant-time guard)', wrongLen.statusCode === 400, `status=${wrongLen.statusCode}`);

  // State-mutating checkout requires an idempotency key.
  const noIdem = await inject({
    method: 'POST',
    url: '/api/v1/checkout/complete',
    headers: JSON_TYPE,
    body: '{}',
  });
  check('POST /checkout/complete without idempotency-key -> 400', noIdem.statusCode === 400, `status=${noIdem.statusCode}`);

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
