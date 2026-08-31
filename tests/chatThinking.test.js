'use strict';

/**
 * POST /chat/thinking — the live "thinking" narration stream.
 *
 * Socket-free (tests/helpers/mockHttp.js): app.handle() with a mock req/res, no
 * port bound. This pins the endpoint's PLUMBING and its core design invariants
 * WITHOUT reaching the network (the sandbox can't reach Groq): it is a view-only
 * stream that never touches the money/audit chain, is reachable UNSIGNED (unlike
 * the mandate-carrying checkout boundaries), and closes cleanly with a plain-text
 * chunked body on the guard path (empty turn → nothing to narrate).
 *
 * The actual token-by-token streaming is powered by GROQ_API_KEY_2 through the AI
 * SDK at runtime and is exercised in the browser, not here — an empty-turn body
 * short-circuits before any model call, so these stay deterministic and offline.
 */

const { handle } = require('./helpers/mockHttp');

/** Fresh app + its shared chain in an isolated module registry (fresh GENESIS). */
function loadApp() {
  let app;
  let sharedAuditLog;
  jest.isolateModules(() => {
    app = require('../src/server');
    ({ sharedAuditLog } = require('../src/lib/auditLog'));
  });
  return { app, sharedAuditLog };
}

function postThinking(app, body) {
  return handle(app, {
    method: 'POST',
    url: '/chat/thinking',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /chat/thinking — live narration stream', () => {
  test('is reachable UNSIGNED and sets streaming (plain-text, no-cache) headers', async () => {
    const { app } = loadApp();
    const res = await postThinking(app, {}); // empty turn → guard closes it at once
    // 200, never 401: it carries no mandate, so the signature guard must not gate it.
    expect(res.statusCode).toBe(200);
    expect(String(res._headers['content-type'])).toMatch(/text\/plain/);
    expect(String(res._headers['cache-control'])).toMatch(/no-cache/);
  });

  test('never appends to the money/audit chain (view-only)', async () => {
    const { app, sharedAuditLog } = loadApp();
    const before = sharedAuditLog.entries().length;
    await postThinking(app, { message: '' }); // empty text → returns before any LLM call
    expect(sharedAuditLog.entries().length).toBe(before);
  });

  test('closes the stream cleanly with an empty body on an empty turn', async () => {
    const { app } = loadApp();
    const res = await postThinking(app, { messages: [] });
    expect(res.finished).toBe(true);
    expect(res.captured).toBe('');
  });
});
