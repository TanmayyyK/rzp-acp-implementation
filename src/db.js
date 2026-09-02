const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

// Tests and contract verification must never write audit/payment fixtures into
// the developer's merchant database. Deployment can explicitly select a
// managed SQLite volume with DATA_DB_PATH.
const dbPath = process.env.DATA_DB_PATH || (process.env.NODE_ENV === 'test'
  ? path.join(os.tmpdir(), `razorpay-commerce-${process.pid}.db`)
  : path.join(__dirname, '../data/products.db'));
const db = new Database(dbPath);

// Initialize schema
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    sku TEXT UNIQUE,
    name TEXT,
    item_type TEXT,
    unit_price_paise INTEGER,
    stock_count INTEGER,
    max_quantity_per_order INTEGER,
    risk_tier TEXT,
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    price_paise INTEGER NOT NULL,
    currency TEXT DEFAULT 'INR',
    availability BOOLEAN DEFAULT 1,
    category TEXT,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  -- Catalog search index for GET /api/v1/products. At 10,000+ SKUs the
  -- unindexed form was a full SCAN products on every agent search.
  --
  -- Column order is deliberate and was chosen by reading EXPLAIN QUERY PLAN,
  -- not by the usual equality-columns-first rule:
  --
  --   availability  fixed prefix -- every search is WHERE availability = 1
  --   COALESCE(...) the ORDER BY key AND the max_price range bound
  --   id            the ORDER BY tiebreaker
  --   category      trailing, so the index still covers a category search
  --
  -- Leading with (availability, category) served the seek but left the sort on
  -- a temp B-tree, and the sort is what actually costs here: SQLite would
  -- materialize and sort every availability=1 row before applying LIMIT 15.
  -- Leading with the price expression instead lets SQLite walk the index in
  -- price order and stop at 15, so every shape the route emits -- broad query,
  -- category, max_price, or any combination -- plans without a temp B-tree.
  --
  -- The price column is the COALESCE expression, not the bare column, because
  -- that is the expression both this route and checkout price from; indexing
  -- unit_price_paise alone would not match the ORDER BY.
  CREATE INDEX IF NOT EXISTS idx_products_search
    ON products(availability, COALESCE(unit_price_paise, price_paise), id, category);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    principal_id TEXT PRIMARY KEY,
    budget_cap_paise INTEGER NOT NULL DEFAULT 1000000,
    delegation_mode TEXT DEFAULT 'full'
  );

  CREATE TABLE IF NOT EXISTS webauthn_credentials (
    principal_id TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT
  );

  CREATE TABLE IF NOT EXISTS delegation_grants (
    mandate_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    mandate_json TEXT NOT NULL,
    max_amount_paise INTEGER NOT NULL,
    challenge TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_delegation_grants_principal
    ON delegation_grants (principal_id, status);

  CREATE TABLE IF NOT EXISTS recovery_offers (
    offer_code TEXT PRIMARY KEY,
    cart_id TEXT NOT NULL,
    offer_type TEXT NOT NULL,
    discount_paise INTEGER NOT NULL,
    final_price_paise INTEGER NOT NULL,
    upsell_sku TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS checkout_sessions (
    session_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_checkout_sessions_state ON checkout_sessions(state);

  CREATE TABLE IF NOT EXISTS checkout_responses (
    session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS checkout_locks (
    session_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    acquired_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payment_attempts (
    session_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    receipt TEXT NOT NULL UNIQUE,
    amount_paise INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    razorpay_id TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS velocity_ledger (
    reservation_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    provisional INTEGER NOT NULL DEFAULT 1
  );
  -- The velocity guardrail's lookup index. Every read in velocityTracker.js
  -- (inWindow: principal_id = ? AND timestamp_ms > ?, and the DELETE that
  -- prunes the window) is served by this compound index, so the rolling-window
  -- scan stays proportional to one principal's live reservations rather than to
  -- the ledger. Verified with EXPLAIN QUERY PLAN:
  --   SEARCH velocity_ledger USING INDEX idx_velocity_principal_time
  --     (principal_id=? AND timestamp_ms>?)
  -- Note: there is no transactions table in this schema. The spend ledger is
  -- velocity_ledger, keyed on timestamp_ms (epoch ms), not created_at. An index
  -- on transactions(principal_id, created_at) would throw "no such table" here
  -- at require() time and take the server down on boot.
  CREATE INDEX IF NOT EXISTS idx_velocity_principal_time
    ON velocity_ledger(principal_id, timestamp_ms);

  CREATE TABLE IF NOT EXISTS webhook_inbox (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    processing_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_processed ON webhook_inbox(processed_at);

  CREATE TABLE IF NOT EXISTS audit_events (
    seq INTEGER PRIMARY KEY,
    entry_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS http_sessions (
    sid TEXT PRIMARY KEY,
    session_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_http_sessions_expiry ON http_sessions(expires_at);
`);

// Seed data if empty
const count = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO products (
      sku, name, item_type, unit_price_paise, stock_count, max_quantity_per_order, risk_tier,
      id, title, description, price_paise, availability, category
    ) VALUES (
      @sku, @name, @item_type, @unit_price_paise, @stock_count, @max_quantity_per_order, @risk_tier,
      @id, @title, @description, @price_paise, @availability, @category
    )
  `);

  const generateSku = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const mapItem = (item) => {
    return {
      sku: item.sku || generateSku(item.name),
      name: item.name,
      item_type: item.item_type || 'PHYSICAL',
      unit_price_paise: item.price_inr * 100,
      stock_count: item.stock_count || 50,
      max_quantity_per_order: item.max_quantity_per_order,
      risk_tier: item.risk_tier,
      id: item.sku || generateSku(item.name),
      title: item.name,
      description: item.description || item.name,
      price_paise: item.price_inr * 100,
      availability: 1,
      category: item.category || 'tech'
    };
  };

  const seedProducts = [
    // 1. Preserve our 4 core archetypes
    {
      sku: 'apple-m3-max-64gb', name: 'Apple M3 Max MacBook Pro 64GB', item_type: 'PHYSICAL',
      price_inr: 350000, stock_count: 10, max_quantity_per_order: 2, risk_tier: 'MODERATE', category: 'hardware'
    },
    {
      sku: 'groq-llama3-70b-1m', name: 'Groq Llama-3 70B API Credits (1M Tokens)', item_type: 'COMPUTE',
      price_inr: 50, stock_count: 10000, max_quantity_per_order: 1000, risk_tier: 'LOW', category: 'software'
    },
    {
      sku: 'github-copilot-ent-1y', name: 'GitHub Copilot Enterprise - 1 Year', item_type: 'SUBSCRIPTION',
      price_inr: 39000, stock_count: 500, max_quantity_per_order: 50, risk_tier: 'LOW', category: 'software'
    },
    {
      sku: 'aws-root-iam-prod-eu', name: 'AWS Root IAM Access Token (Prod-EU)', item_type: 'RESTRICTED',
      price_inr: 1000, stock_count: 1, max_quantity_per_order: 1, risk_tier: 'CRITICAL', category: 'software'
    },

    // [ Flagship & Mid-Range Smartphones ]
    { name: 'Apple iPhone 15 Pro Max 256GB - Titanium', price_inr: 159900, risk_tier: 'MODERATE', max_quantity_per_order: 2, category: 'smartphone' },
    { name: 'Apple iPhone 15 128GB - Blue', price_inr: 59900, risk_tier: 'LOW', max_quantity_per_order: 3, category: 'smartphone' },
    { name: 'Samsung Galaxy S24 Ultra 512GB - Titanium Black', price_inr: 139999, risk_tier: 'MODERATE', max_quantity_per_order: 2, category: 'smartphone' },
    { name: 'Google Pixel 8 Pro 128GB - Obsidian', price_inr: 106999, risk_tier: 'MODERATE', max_quantity_per_order: 2, category: 'smartphone' },
    { name: 'Nothing Phone (2) 256GB - Dark Grey', price_inr: 39999, risk_tier: 'LOW', max_quantity_per_order: 3, category: 'smartphone' },
    { name: 'OnePlus 12R 256GB - Iron Gray', price_inr: 45999, risk_tier: 'LOW', max_quantity_per_order: 3, category: 'smartphone' },

    // [ Laptops & Developer Workstations ]
    { name: 'Dell XPS 14 - Intel Core Ultra 7, 32GB RAM', price_inr: 174990, risk_tier: 'MODERATE', max_quantity_per_order: 2, category: 'laptop' },
    { name: 'Lenovo ThinkPad X1 Carbon Gen 11 - 16GB RAM', price_inr: 145000, risk_tier: 'MODERATE', max_quantity_per_order: 5, category: 'laptop' },
    { name: 'Apple MacBook Air M3 13-inch 16GB RAM', price_inr: 134900, risk_tier: 'MODERATE', max_quantity_per_order: 3, category: 'laptop' },
    { name: 'ASUS ROG Zephyrus G14 Gaming Laptop', price_inr: 164990, risk_tier: 'MODERATE', max_quantity_per_order: 2, category: 'laptop' },
    { name: 'Raspberry Pi 5 - 8GB', price_inr: 8499, risk_tier: 'LOW', max_quantity_per_order: 10, category: 'laptop' },

    // [ Tablets & E-Readers ]
    { name: 'Apple iPad Air 11-inch (M2)', price_inr: 59900, risk_tier: 'LOW', max_quantity_per_order: 2, category: 'tablet' },
    { name: 'Apple iPad Pro 13-inch (M4)', price_inr: 129900, risk_tier: 'MODERATE', max_quantity_per_order: 2, category: 'tablet' },
    { name: 'Samsung Galaxy Tab S9 Ultra', price_inr: 108999, risk_tier: 'MODERATE', max_quantity_per_order: 2, category: 'tablet' },
    { name: 'Amazon Kindle Paperwhite (16 GB)', price_inr: 14999, risk_tier: 'LOW', max_quantity_per_order: 4, category: 'tablet' },

    // [ Audio & Wearables ]
    { name: 'Sony WH-1000XM5 Wireless Noise Cancelling Headphones', price_inr: 29990, risk_tier: 'LOW', max_quantity_per_order: 4, category: 'audio' },
    { name: 'Apple AirPods Pro (2nd Generation)', price_inr: 24900, risk_tier: 'LOW', max_quantity_per_order: 3, category: 'audio' },
    { name: 'Bose QuietComfort Ultra Earbuds', price_inr: 25900, risk_tier: 'LOW', max_quantity_per_order: 3, category: 'audio' },
    { name: 'Nothing Ear (a) Wireless Earbuds', price_inr: 7999, risk_tier: 'LOW', max_quantity_per_order: 5, category: 'audio' },
    { name: 'Apple Watch Series 9 - 45mm', price_inr: 44900, risk_tier: 'LOW', max_quantity_per_order: 3, category: 'wearable' },
    { name: 'Garmin Fenix 7 Pro Sapphire Solar', price_inr: 84990, risk_tier: 'MODERATE', max_quantity_per_order: 2, category: 'wearable' },
    { name: 'Noise ColorFit Pulse 2 Smartwatch', price_inr: 1499, risk_tier: 'LOW', max_quantity_per_order: 10, category: 'wearable' },

    // [ Peripherals & Desk Setup ]
    { name: 'Logitech MX Master 3S Wireless Mouse', price_inr: 8995, risk_tier: 'LOW', max_quantity_per_order: 5, category: 'peripheral' },
    { name: 'Logitech MX Keys S Wireless Keyboard', price_inr: 10995, risk_tier: 'LOW', max_quantity_per_order: 5, category: 'peripheral' },
    { name: 'Keychron K2 V2 Mechanical Keyboard', price_inr: 7499, risk_tier: 'LOW', max_quantity_per_order: 5, category: 'peripheral' },
    { name: 'LG 27-inch 4K UHD USB-C Monitor', price_inr: 32000, risk_tier: 'LOW', max_quantity_per_order: 2, category: 'peripheral' },
    { name: 'Dell UltraSharp 32 4K USB-C Hub Monitor', price_inr: 78000, risk_tier: 'MODERATE', max_quantity_per_order: 2, category: 'peripheral' },
    { name: 'CalDigit TS4 Thunderbolt 4 Dock', price_inr: 35999, risk_tier: 'LOW', max_quantity_per_order: 2, category: 'peripheral' },

    // [ Storage & Accessories ]
    { name: 'Samsung T7 1TB Portable External SSD', price_inr: 8499, risk_tier: 'LOW', max_quantity_per_order: 10, category: 'accessory' },
    { name: 'SanDisk Extreme Pro 2TB Portable NVMe SSD', price_inr: 16999, risk_tier: 'LOW', max_quantity_per_order: 5, category: 'accessory' },
    { name: 'Anker 737 Power Bank (PowerCore 24K)', price_inr: 12999, risk_tier: 'LOW', max_quantity_per_order: 4, category: 'accessory' },
    { name: 'Spigen 65W GaN Dual USB-C Fast Charger', price_inr: 2499, risk_tier: 'LOW', max_quantity_per_order: 10, category: 'accessory' },
    { name: 'Belkin BOOST↑CHARGE Pro 3-in-1 Wireless Stand', price_inr: 12900, risk_tier: 'LOW', max_quantity_per_order: 5, category: 'accessory' },
    { name: 'Apple Braided USB-C to USB-C Cable (2m)', price_inr: 1900, risk_tier: 'LOW', max_quantity_per_order: 15, category: 'accessory' }
  ].map(mapItem);

  const insertMany = db.transaction((prods) => {
    for (const p of prods) insert.run(p);
  });
  insertMany(seedProducts);
}

module.exports = db;
