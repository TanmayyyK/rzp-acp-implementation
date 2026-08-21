'use strict';

/**
 * server.js — composition root for the Agentic Commerce Platform.
 *
 * Architecture (see docs/ARCHITECTURE.md):
 *   - Webhook route MUST come before express.json() so the raw body
 *     is preserved as a Buffer for HMAC-SHA256 verification.
 *   - All other routes use express.json() normally.
 *   - The app is exported without calling listen() so tests can
 *     drive it in-process.
 */

const express = require('express');
const config = require('./config');

// Route modules
const webhookRouter = require('./routes/webhooks');
const ordersRouter = require('./routes/orders');
const checkoutRouter = require('./routes/checkout');
const productsRouter = require('./routes/products');
const feedRouter = require('./routes/feed');

const app = express();

// ==========================================
// 1. ACP Discovery Endpoint (no body parsing needed)
// ==========================================
app.get('/.well-known/acp.json', (_req, res) => {
  res.json({
    version: '2.0',
    name: 'Agentic Commerce Node',
    description: 'ACP-shaped checkout + AP2-shaped mandates on Razorpay test-mode rails',
    capabilities: ['search', 'recommend', 'compare', 'negotiate', 'transact'],
    endpoints: {
      products: '/api/v1/products',
      checkout_sessions: '/api/v1/checkout/sessions',
      webhooks: '/api/v1/webhooks/razorpay',
    },
    checkout_lifecycle: ['CREATED', 'CONFIRMED', 'PAID', 'FULFILLING', 'COMPLETED'],
    supported_currencies: ['INR'],
    supported_protocols: ['ACP-2.0', 'AP2'],
  });
});

// ==========================================
// 2. Webhook route — raw body, BEFORE express.json()
// ==========================================
app.use('/api/v1/webhooks/razorpay', express.raw({ type: 'application/json' }), webhookRouter);

// ==========================================
// 3. JSON body parser for everything else
// ==========================================
app.use(express.json());

// ==========================================
// 4. Application routes
// ==========================================
app.use('/api/v1/products', productsRouter);
app.use('/api/v1/feed', feedRouter);
app.use('/api/v1/orders', ordersRouter);
app.use('/api/v1/checkout', checkoutRouter);

// ==========================================
// 5. Health check
// ==========================================
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// Start server only when run directly
// ==========================================
if (require.main === module) {
  const port = config.port;
  app.listen(port, () => {
    console.log(`🚀 Agentic Commerce Platform listening on port ${port}`);
    console.log(`🔍 ACP Discovery: http://localhost:${port}/.well-known/acp.json`);
    console.log(`🪝 Webhooks:      http://localhost:${port}/api/v1/webhooks/razorpay`);
    console.log(`📦 Products:      http://localhost:${port}/api/v1/products`);
    console.log(`💳 Orders:        http://localhost:${port}/api/v1/orders`);
    console.log(`🛒 Checkout:      http://localhost:${port}/api/v1/checkout/sessions`);
  });
}

module.exports = app;
