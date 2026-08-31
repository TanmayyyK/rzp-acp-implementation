# Agent Commerce Layer for Razorpay

*ACP-shaped checkout + AP2-shaped mandates with a guarded Razorpay payment-intent flow, durable local transaction state, and a UAP-style guardrail/audit layer. An order is pending payment until a verified webhook marks it PAID.*

## Overview
This repository implements the Day 1 to Day 15 Razorpay Buildathon project. It provides an Agent Commerce Protocol (ACP) compliant interface for AI agents to discover products and execute checkouts, backed by Razorpay's payment infrastructure, while strictly enforcing Agent Payments Protocol (AP2) mandate authorization and security guardrails.

## Documentation
- [Architecture](docs/ARCHITECTURE.md)
- [Architecture Decisions (ADRs)](docs/DECISIONS.md)
- [API Mapping & Cheat Sheet](docs/API_MAPPING_CHEAT_SHEET.md)

## Development Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   Copy `.env.example` to `.env` and fill in your Razorpay test keys:
   ```bash
   cp .env.example .env
   ```

3. **Run tests:**
   ```bash
   npm test
   ```

4. **Start the server:**
   ```bash
   npm run dev
   ```

## Key Technologies
- **Node.js 20+** & **Express**
- **Razorpay SDK** (Orders & Payment Links)
- **Native Crypto** (HMAC-SHA256 and ES256/EdDSA signing)

### System Limitations & Positioning: Autonomous Order Orchestration
This platform currently demonstrates **autonomous order orchestration** rather than end-to-end payment settlement. Under-threshold purchases yield a Razorpay Order (an intent to collect), which acts as a pending collection artifact. Full autonomous payment capture would require an active tokenized payment method (e.g. eNACH, cards, or saved UPI mandates) that is out-of-scope for this basic demonstration.
