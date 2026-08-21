const express = require('express');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// ACP Discovery Endpoint
// Protocol: Agent Commerce Protocol (ACP) v2.0
// ==========================================
app.get('/.well-known/acp.json', (req, res) => {
    res.json({
        "version": "2.0",
        "name": "Agentic Commerce Node",
        "description": "Razorpay Buildathon Day 1 Agentic Commerce Platform",
        // ACP v2.0 capability vocabulary (per the Agent Commerce Protocol spec).
        "capabilities": [
            "search",
            "recommend",
            "compare",
            "negotiate",
            "transact"
        ],
        "endpoints": {
            "checkout": "/api/v1/checkout",
            "products": "/api/v1/products",
            "intents": "/api/v1/intents",
            "webhooks": "/api/v1/webhooks/razorpay"
        },
        // The 5-stage checkout session lifecycle defined by ACP v2.0.
        "checkout_lifecycle": ["CREATED", "CONFIRMED", "PAID", "FULFILLING", "COMPLETED"],
        "supported_currencies": ["INR"],
        "supported_protocols": ["ACP-2.0", "AP2"]
    });
});

// ==========================================
// Middleware: Razorpay Webhook Raw Body Capture
// ==========================================
// To validate Razorpay webhooks, the raw request body must be used to generate the HMAC-SHA256 signature.
// Parsing it to JSON before validation will alter the structure/formatting and fail the signature check.
const razorpayWebhookMiddleware = express.raw({ type: 'application/json' });

app.post('/api/v1/webhooks/razorpay', razorpayWebhookMiddleware, (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const razorpaySignature = req.headers['x-razorpay-signature'];
        
        if (!webhookSecret) {
            console.error('RAZORPAY_WEBHOOK_SECRET is not configured');
            return res.status(500).send('Webhook secret not configured');
        }

        if (!razorpaySignature) {
            return res.status(400).send('Missing Razorpay signature header');
        }

        // The req.body is a Buffer since we used express.raw
        // Native Node.js crypto module utilized for HMAC-SHA256 webhook signature validation
        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(req.body)
            .digest();

        // Constant-time comparison to avoid leaking the signature via timing side-channel.
        // crypto.timingSafeEqual throws on unequal-length buffers, so length is checked first.
        const receivedSignature = Buffer.from(razorpaySignature, 'hex');
        const signatureValid =
            expectedSignature.length === receivedSignature.length &&
            crypto.timingSafeEqual(expectedSignature, receivedSignature);

        if (!signatureValid) {
            console.warn('Invalid Razorpay webhook signature detected.');
            return res.status(400).send('Invalid signature');
        }

        // Signature is valid, now we can parse the JSON
        const event = JSON.parse(req.body.toString('utf8'));
        console.log(`[Webhook] Valid event received: ${event.event} [ID: ${event.id}]`);

        // ==========================================
        // Event Handling & Idempotency
        // ==========================================
        // Note: Implement idempotency here by checking if event.id has already been processed
        // before executing state mutations.

        switch (event.event) {
            case 'order.paid':
                console.log(`Order paid: ${event.payload.order.entity.id}`);
                // TODO: Update local order state
                break;
            case 'payment.captured':
                console.log(`Payment captured: ${event.payload.payment.entity.id}`);
                // TODO: Fulfill the order
                break;
            default:
                console.log(`Unhandled webhook event type: ${event.event}`);
        }

        res.status(200).send({ status: 'success' });
    } catch (error) {
        console.error('Error processing Razorpay webhook:', error);
        // Do not leak error details to the webhook sender
        res.status(500).send('Internal Server Error');
    }
});

// ==========================================
// General Application Middleware
// ==========================================
// For all other routes, parse JSON normally.
app.use(express.json());

// Example route demonstrating idempotency key checking placeholder
app.post('/api/v1/checkout/complete', (req, res) => {
    const idempotencyKey = req.headers['idempotency-key'];
    
    if (!idempotencyKey) {
        return res.status(400).json({ error: 'idempotency-key header is required' });
    }

    // TODO: Implement idempotency check using Redis or Postgres
    // if (await isIdempotencyKeyProcessed(idempotencyKey)) {
    //    return res.status(200).json(await getCachedResponse(idempotencyKey));
    // }

    res.json({ message: "Checkout complete endpoint placeholder" });
});

// Only bind a port when run directly (`node src/server.js`), so the app can be
// imported by tests/harnesses without starting a listener.
if (require.main === module) {
    app.listen(port, () => {
        console.log(`🚀 Agentic Commerce Platform listening on port ${port}`);
        console.log(`🔍 ACP Discovery: http://localhost:${port}/.well-known/acp.json`);
        console.log(`🪝 Webhooks URL: http://localhost:${port}/api/v1/webhooks/razorpay`);
    });
}

module.exports = app;
