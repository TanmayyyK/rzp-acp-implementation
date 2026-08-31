'use strict';

/**
 * Socket-free HTTP harness for driving an Express app in-process.
 *
 * supertest binds an ephemeral port (app.listen), which is blocked in this
 * sandbox (EPERM), so every suite here drives the app directly instead.
 *
 * This is a thin shim over tests/helpers/inject.js, which owns the actual
 * request/response construction. It used to hand Express a bare Readable with
 * no socket attached; once the app grew an express-session layer for the human
 * WebAuthn ceremony, `req.protocol`/`req.secure` started reading
 * `req.connection.encrypted` off that missing socket and threw. The request then
 * fell through to the error path with `res.end` never called, which surfaced in
 * five suites as "status 200, zero-length body" (Unexpected end of JSON input).
 * inject.js builds a real http.IncomingMessage over a socket stub, so there is
 * one harness to keep correct rather than two.
 */

const { inject } = require('./inject');

/**
 * Run one request through `app` and resolve with a finished-response view
 * ({ statusCode, _headers, captured, finished }), the shape these suites read.
 *
 * @param {import('express').Express} app
 * @param {{method?: string, url: string, headers?: object, body?: string|object}} reqSpec
 */
async function handle(app, reqSpec) {
  const result = await inject(app, reqSpec);
  return {
    statusCode: result.status,
    _headers: result.headers,
    captured: result.text,
    finished: true,
  };
}

module.exports = { handle };
