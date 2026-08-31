const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../data/products.db');
const db = new Database(dbPath);

// Initialize schema
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
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

  -- A human's signed grant of spending authority to an agent.
  --
  -- This is the root of trust for autonomous checkout: the IntentMandate stored
  -- here was signed by the human's authenticator, so the agent references a
  -- grant it cannot mint. The status column is the human's kill switch, checked
  -- on every use rather than only at issuance.
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
`);

// Seed data if empty
const count = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO products (id, title, description, price_paise, availability, category, image_url)
    VALUES (@id, @title, @description, @price_paise, @availability, @category, @image_url)
  `);
  
  const seedProducts = [
    { id: 'prod_elec_001', title: 'Noise ColorFit Pulse 2 Smartwatch', description: '1.69-inch HD display smartwatch with SpO2 tracking, 60 sports modes, and up to 7 days of battery life.', price_paise: 249900, availability: 1, category: 'electronics', image_url: 'https://m.media-amazon.com/images/I/61uA2UVnYWL._SX679_.jpg' },
    { id: 'prod_elec_002', title: 'Boult Audio Z40 Wireless Bluetooth Earbuds', description: 'True wireless earbuds with 40 hours total playback, ENC call noise cancellation, and IPX5 sweat resistance.', price_paise: 179900, availability: 1, category: 'audio', image_url: 'https://m.media-amazon.com/images/I/61nS1oT8iTL._SX679_.jpg' },
    { id: 'prod_elec_003', title: 'Mi Power Bank 3i 20000mAh 18W Fast Charging', description: 'High-capacity 20000mAh power bank with 18W two-way fast charging.', price_paise: 199900, availability: 1, category: 'electronics', image_url: 'https://m.media-amazon.com/images/I/71lVwl3q-kL._SX679_.jpg' },
    { id: 'prod_elec_004', title: 'Razer Huntsman Mini 60% Gaming Keyboard', description: 'Fast keyboard switches, compact form factor, and Razer Chroma RGB.', price_paise: 859900, availability: 0, category: 'computers', image_url: 'https://m.media-amazon.com/images/I/61Lq056Lp1L._SX679_.jpg' },
    { id: 'prod_elec_005', title: 'Sony WH-1000XM5 Wireless Headphones', description: 'Industry leading noise cancellation, 30-hour battery life.', price_paise: 2999000, availability: 1, category: 'audio', image_url: 'https://m.media-amazon.com/images/I/61vJtKbAssL._SX679_.jpg' },
    { id: 'prod_elec_006', title: 'Logitech MX Master 3S Wireless Mouse', description: 'Ergonomic, 8K DPI, quiet clicks, and ultra-fast scrolling.', price_paise: 899900, availability: 1, category: 'computers', image_url: 'https://m.media-amazon.com/images/I/61ni3t1ryQL._SX679_.jpg' },
    { id: 'prod_elec_007', title: 'Apple 20W USB-C Power Adapter', description: 'Fast, efficient charging for iPhone and iPad devices.', price_paise: 190000, availability: 1, category: 'accessories', image_url: 'https://m.media-amazon.com/images/I/61vtLhO6fDL._SX679_.jpg' },
    { id: 'prod_elec_008', title: 'Amazon Echo Dot (4th Gen)', description: 'Smart speaker with Alexa and crisp, balanced sound.', price_paise: 399900, availability: 1, category: 'smart_home', image_url: 'https://m.media-amazon.com/images/I/6182S7MYC2L._SX679_.jpg' },
    { id: 'prod_elec_009', title: 'Samsung T7 1TB Portable SSD', description: 'Up to 1050MB/s USB 3.2 Gen 2, rugged metal casing.', price_paise: 849900, availability: 1, category: 'computers', image_url: 'https://m.media-amazon.com/images/I/91Z1kO0n5vL._SX679_.jpg' },
    { id: 'prod_elec_010', title: 'Kindle Paperwhite (8GB)', description: 'Now with a 6.8" display and adjustable warm light.', price_paise: 1399900, availability: 1, category: 'electronics', image_url: 'https://m.media-amazon.com/images/I/51qc2OxcWGL._SX679_.jpg' }
  ];

  const insertMany = db.transaction((prods) => {
    for (const p of prods) insert.run(p);
  });
  insertMany(seedProducts);
}

module.exports = db;
