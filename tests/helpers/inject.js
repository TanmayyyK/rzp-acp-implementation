'use strict';

/**
 * In-process HTTP injection for the Express app — no sockets, no ports.
 *
 * The adversarial suites used to bind a real TCP listener and drive it with
 * global fetch. That needs `listen()`, which is unavailable in sandboxed /
 * restricted CI environments (EPERM), so the whole security regression suite
 * silently became unrunnable. This harness builds a real http.IncomingMessage /
 * http.ServerResponse pair and hands them straight to `app(req, res)`, so every
 * layer under test — express routing, express.json(), express-session cookies,
 * the route handlers — runs exactly as it does over a socket.
 *
 * Deliberately test-only: nothing in src/ imports this.
 */

const http = require('http');

// A socket stub that satisfies the bits IncomingMessage/ServerResponse touch
// without any real I/O. `readable: false` keeps IncomingMessage._read from
// trying to resume a real socket; we feed the body with req.push() instead.
function fakeSocket() {
  return {
    encrypted: false,
    remoteAddress: '127.0.0.1',
    remotePort: 0,
    readable: false,
    writable: true,
    destroyed: false,
    destroy() {},
    resume() {},
    pause() {},
    setTimeout() {},
    setKeepAlive() {},
    setNoDelay() {},
    cork() {},
    uncork() {},
    write() { return true; },
    end() {},
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
    emit() { return false; },
  };
}

/**
 * Drive one request through an Express app in-process.
 *
 * @param {import('express').Express} app
 * @param {object} options
 * @param {string} [options.method='GET']
 * @param {string} options.url                Path + query, e.g. '/api/v1/products?q=x'
 * @param {Record<string,string>} [options.headers]
 * @param {object|string} [options.body]      Serialized as JSON when not a string
 * @returns {Promise<{status:number, headers:object, text:string, body:any, cookie:string|null}>}
 */
function inject(app, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const socket = fakeSocket();
    const req = new http.IncomingMessage(socket);
    req.method = String(method).toUpperCase();
    req.url = url;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;

    let raw = null;
    if (body !== undefined && body !== null) {
      raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    }

    const merged = { host: '127.0.0.1', ...headers };
    if (raw && merged['content-type'] === undefined && merged['Content-Type'] === undefined) {
      merged['Content-Type'] = 'application/json';
    }
    req.headers = {};
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== null) req.headers[k.toLowerCase()] = String(v);
    }
    if (raw) req.headers['content-length'] = String(raw.length);

    const res = new http.ServerResponse(req);
    const chunks = [];
    let settled = false;

    function push(chunk, enc) {
      if (!chunk) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
    }

    function settle() {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON response */ }
      const outHeaders = res.getHeaders();
      const setCookie = outHeaders['set-cookie'];
      resolve({
        status: res.statusCode,
        headers: outHeaders,
        text,
        body: parsed,
        // First cookie pair only — enough to carry an express-session id forward.
        cookie: setCookie ? [].concat(setCookie).map((c) => String(c).split(';')[0]).join('; ') : null,
      });
    }

    res.write = function write(chunk, enc, cb) {
      push(chunk, enc);
      const done = typeof enc === 'function' ? enc : cb;
      if (typeof done === 'function') done();
      return true;
    };

    res.end = function end(chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; enc = null; }
      push(chunk, enc);
      // Run the real header pipeline so on-headers hooks fire — this is what
      // makes express-session actually emit Set-Cookie.
      if (!res._header) {
        try { res._implicitHeader(); } catch { /* headers already sent */ }
      }
      const done = typeof enc === 'function' ? enc : cb;
      if (typeof done === 'function') done();
      settle();
      return res;
    };

    app(req, res, (err) => {
      if (err) return reject(err);
      res.statusCode = 404;
      res.end('Not Found');
    });

    if (raw) req.push(raw);
    req.push(null);
  });
}

/**
 * A `fetch`-shaped adapter over inject(), for code that speaks fetch (the MCP
 * merchant client). Carries a cookie jar so an authenticated human session can
 * be threaded through — or deliberately withheld, to prove the agent path needs
 * no cookie.
 *
 * @param {import('express').Express} app
 * @param {{cookie?: string|null}} [jar]
 */
function injectFetch(app, jar = {}) {
  return async function fetchImpl(url, init = {}) {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '') || '/';
    const headers = { ...(init.headers || {}) };
    if (jar.cookie && !headers.Cookie && !headers.cookie) headers.Cookie = jar.cookie;
    const result = await inject(app, {
      method: init.method || 'GET',
      url: path,
      headers,
      body: init.body,
    });
    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      headers: { get: (name) => result.headers[String(name).toLowerCase()] || null },
      text: async () => result.text,
      json: async () => result.body,
    };
  };
}

module.exports = { inject, injectFetch };
