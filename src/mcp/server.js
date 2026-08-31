'use strict';

/**
 * Razorpay ACP Merchant — MCP stdio server (thin entrypoint).
 *
 * All checkout logic lives in ./merchantClient (dependency-free, unit-tested
 * in tests/mcpMerchantTools.test.js). This file only wires that core to the
 * Model Context Protocol over stdio, so an LLM / buyer-agent can drive the
 * 5-stage ACP checkout through clean tools — never touching REST, signatures,
 * or paise arithmetic (docs/ARCHITECTURE.md §3.5).
 *
 * Requires `@modelcontextprotocol/sdk`, installed via `npm install`. The SDK is
 * NOT needed for the unit tests, which exercise ./merchantClient directly with
 * a mock fetch.
 *
 * Run:   npm run mcp      (or: node src/mcp/server.js)
 * Then register this process as an MCP stdio server in your MCP client, with
 * the merchant server (npm start) reachable at MERCHANT_BASE_URL.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { TOOL_DEFINITIONS, createMerchantTools } = require('./merchantClient');
const { version } = require('../../package.json');

async function main() {
  const tools = createMerchantTools();

  const server = new Server(
    { name: 'razorpay-acp-merchant', version: version || '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // tools/list → the air-gapped tool surface.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // tools/call → dispatch to the matching handler. A thrown error (including
  // the circuit-breaker's `YIELD_TO_HUMAN: ...` signal) is turned into an MCP
  // tool error with isError:true, so its message reaches the LLM verbatim
  // rather than crashing the transport.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = tools[name];
    if (!handler) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    try {
      const result = await handler(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: err && err.message ? err.message : String(err) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the JSON-RPC channel and must stay clean.
  console.error('[MCP] razorpay-acp-merchant connected over stdio.');
}

// Guard: require()-ing this file (e.g. in a test) must not auto-start the server.
if (require.main === module) {
  main().catch((err) => {
    console.error('[MCP] Fatal:', err);
    process.exit(1);
  });
}

module.exports = { main };
