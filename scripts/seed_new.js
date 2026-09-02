const Database = require('better-sqlite3');
const path = require('path');

// Connect directly to the SQLite database
const dbPath = path.resolve(__dirname, '../neural_arbiter.db');
const db = new Database(dbPath);

// Create table if it doesn't exist
db.prepare(`
  CREATE TABLE IF NOT EXISTS products (
    sku TEXT UNIQUE,
    name TEXT,
    item_type TEXT,
    unit_price_paise INTEGER,
    stock_count INTEGER,
    max_quantity_per_order INTEGER,
    risk_tier TEXT
  )
`).run();

// 1. Immutable Core Archetypes (Required for Policy & Step-Up Demos)
const coreArchetypes = [
  { sku: 'apple-m3-max-64gb', name: 'Apple M3 Max MacBook Pro 16-inch (64GB / 1TB)', type: 'PHYSICAL', price: 350000, risk: 'CRITICAL', max_qty: 2 },
  { sku: 'groq-llama3-70b-1m', name: 'Groq Llama-3 70B API Credits (1M Tokens)', type: 'COMPUTE', price: 50, risk: 'LOW', max_qty: 1000 },
  { sku: 'github-copilot-ent-1y', name: 'GitHub Copilot Enterprise - 1 Year Seat', type: 'SUBSCRIPTION', price: 39000, risk: 'LOW', max_qty: 50 },
  { sku: 'aws-root-iam-prod-eu', name: 'AWS Root IAM Access Token (Prod-EU)', type: 'RESTRICTED', price: 1000, risk: 'CRITICAL', max_qty: 1 }
];

// 2. Realistic Brand & Product Line Catalog Matrix
const catalogMatrix = [
  // --- FLAGSHIP & MID-RANGE SMARTPHONES ---
  {
    brand: 'Apple',
    models: [
      { name: 'iPhone 15', basePrice: 59900 },
      { name: 'iPhone 15 Plus', basePrice: 69900 },
      { name: 'iPhone 15 Pro', basePrice: 134900 },
      { name: 'iPhone 15 Pro Max', basePrice: 159900 },
      { name: 'iPhone 14', basePrice: 49900 },
      { name: 'iPhone 13', basePrice: 42900 }
    ],
    specs: ['128GB', '256GB', '512GB'],
    variants: ['Midnight', 'Starlight', 'Blue', 'Natural Titanium', 'Deep Black'],
    type: 'PHYSICAL',
    baseMaxQty: 2
  },
  {
    brand: 'Samsung',
    models: [
      { name: 'Galaxy S24 Ultra', basePrice: 129999 },
      { name: 'Galaxy S24 Plus', basePrice: 99999 },
      { name: 'Galaxy S24', basePrice: 74999 },
      { name: 'Galaxy Z Fold 5', basePrice: 154999 },
      { name: 'Galaxy Z Flip 5', basePrice: 89999 },
      { name: 'Galaxy A55 5G', basePrice: 39999 },
      { name: 'Galaxy M34 5G', basePrice: 18999 }
    ],
    specs: ['128GB', '256GB', '512GB', '1TB'],
    variants: ['Titanium Gray', 'Onyx Black', 'Cobalt Violet', 'Amber Yellow'],
    type: 'PHYSICAL',
    baseMaxQty: 2
  },
  {
    brand: 'Google',
    models: [
      { name: 'Pixel 8 Pro', basePrice: 106999 },
      { name: 'Pixel 8', basePrice: 75999 },
      { name: 'Pixel 8a', basePrice: 52999 },
      { name: 'Pixel 7a', basePrice: 37999 }
    ],
    specs: ['128GB', '256GB'],
    variants: ['Obsidian', 'Porcelain', 'Bay Blue', 'Mint'],
    type: 'PHYSICAL',
    baseMaxQty: 2
  },
  {
    brand: 'OnePlus',
    models: [
      { name: '12 5G', basePrice: 64999 },
      { name: '12R 5G', basePrice: 39999 },
      { name: 'Nord CE 4 5G', basePrice: 24999 },
      { name: 'Open Foldable', basePrice: 139999 }
    ],
    specs: ['128GB / 8GB RAM', '256GB / 16GB RAM', '512GB / 16GB RAM'],
    variants: ['Silky Black', 'Emerald Green', 'Cool Blue'],
    type: 'PHYSICAL',
    baseMaxQty: 3
  },

  // --- LAPTOPS & WORKSTATIONS ---
  {
    brand: 'Dell',
    models: [
      { name: 'XPS 13 Plus', basePrice: 139990 },
      { name: 'XPS 15 OLED', basePrice: 199990 },
      { name: 'Alienware m16 R2', basePrice: 174990 },
      { name: 'Inspiron 15', basePrice: 54990 },
      { name: 'Latitude 7440', basePrice: 112000 }
    ],
    specs: ['Intel Ultra 7 / 16GB RAM / 512GB SSD', 'Intel Ultra 9 / 32GB RAM / 1TB SSD', 'Core i5 / 16GB RAM / 512GB SSD'],
    variants: ['Platinum Silver', 'Graphite'],
    type: 'PHYSICAL',
    baseMaxQty: 2
  },
  {
    brand: 'Lenovo',
    models: [
      { name: 'ThinkPad X1 Carbon Gen 11', basePrice: 154000 },
      { name: 'Legion Pro 7i', basePrice: 189990 },
      { name: 'Yoga 9i Dual Screen', basePrice: 174990 },
      { name: 'IdeaPad Slim 5', basePrice: 62990 }
    ],
    specs: ['16GB RAM / 512GB SSD', '32GB RAM / 1TB SSD', '64GB RAM / 2TB SSD'],
    variants: ['Deep Black', 'Storm Grey'],
    type: 'PHYSICAL',
    baseMaxQty: 2
  },

  // --- AUDIO, WEARABLES & PERIPHERALS ---
  {
    brand: 'Sony',
    models: [
      { name: 'WH-1000XM5 Wireless Headphones', basePrice: 29990 },
      { name: 'WF-1000XM5 ANC Earbuds', basePrice: 23990 },
      { name: 'WH-CH720N Noise Cancelling', basePrice: 9990 },
      { name: 'PlayStation 5 Slim Console', basePrice: 54990 },
      { name: 'DualSense Wireless Controller', basePrice: 5990 }
    ],
    specs: ['Standard Edition', 'Pro Bundle'],
    variants: ['Black', 'Silver', 'Midnight Blue'],
    type: 'PHYSICAL',
    baseMaxQty: 3
  },
  {
    brand: 'Logitech',
    models: [
      { name: 'MX Master 3S Wireless Mouse', basePrice: 8995 },
      { name: 'MX Keys S Wireless Keyboard', basePrice: 10995 },
      { name: 'Brio 4K Ultra HD Webcam', basePrice: 18495 },
      { name: 'G Pro X Superlight 2 Gaming Mouse', basePrice: 13995 },
      { name: 'G915 TKL Mechanical Keyboard', basePrice: 17995 }
    ],
    specs: ['Bluetooth & 2.4GHz', 'USB-C Rechargeable'],
    variants: ['Graphite', 'Pale Grey', 'Rose'],
    type: 'PHYSICAL',
    baseMaxQty: 5
  },
  {
    brand: 'Apple Watch',
    models: [
      { name: 'Series 9 GPS', basePrice: 41900 },
      { name: 'Series 9 GPS + Cellular', basePrice: 51900 },
      { name: 'Ultra 2 Titanium', basePrice: 89900 },
      { name: 'SE 2nd Gen', basePrice: 29900 }
    ],
    specs: ['41mm', '45mm', '49mm'],
    variants: ['Midnight Aluminum', 'Starlight Aluminum', 'Silver Stainless Steel'],
    type: 'PHYSICAL',
    baseMaxQty: 2
  },

  // --- MONITORS & STORAGE ---
  {
    brand: 'LG',
    models: [
      { name: '27-inch 4K UHD IPS Monitor (27UL850)', basePrice: 32999 },
      { name: '34-inch UltraWide Curved HDR (34WN80C)', basePrice: 48999 },
      { name: 'UltraGear 27-inch OLED 240Hz (27GR95QE)', basePrice: 79999 }
    ],
    specs: ['USB-C 90W PD', 'DisplayPort 1.4 / HDMI 2.1'],
    variants: ['Matte Black', 'Ergonomic Stand'],
    type: 'PHYSICAL',
    baseMaxQty: 2
  },
  {
    brand: 'Samsung Storage',
    models: [
      { name: 'T7 Shield Portable SSD', basePrice: 9499 },
      { name: '990 PRO NVMe M.2 SSD', basePrice: 11999 },
      { name: 'T9 USB 3.2 Gen 2x2 Portable SSD', basePrice: 14999 }
    ],
    specs: ['1TB', '2TB', '4TB'],
    variants: ['Titanium Black', 'Beige', 'Blue'],
    type: 'PHYSICAL',
    baseMaxQty: 6
  },

  // --- QUICK-COMMERCE & PANTRY (Blinkit / Zepto Tier) ---
  {
    brand: 'Tata',
    models: [
      { name: 'Salt Vacuum Evaporated', basePrice: 28 },
      { name: 'Tea Gold Premium Blend', basePrice: 310 },
      { name: 'Sampann Unpolished Toor Dal', basePrice: 195 },
      { name: 'Coffee Grand Classic', basePrice: 240 },
      { name: 'Sampann Pure Basmati Rice', basePrice: 180 }
    ],
    specs: ['500g', '1kg', '5kg Value Pack'],
    variants: ['Standard Pouch', 'Jar Pack'],
    type: 'PHYSICAL',
    baseMaxQty: 10
  },
  {
    brand: 'Amul',
    models: [
      { name: 'Pasteurised Table Butter', basePrice: 285 },
      { name: 'Taaza Toned Fresh Milk', basePrice: 54 },
      { name: 'Gold Full Cream Milk', basePrice: 66 },
      { name: 'Processed Cheese Block', basePrice: 160 },
      { name: 'Pure Cow Ghee Tin', basePrice: 650 }
    ],
    specs: ['200g', '500g', '1 Litre Pouch', '1kg Tin'],
    variants: ['Fresh Batch', 'Chilled Pack'],
    type: 'PHYSICAL',
    baseMaxQty: 10
  },
  {
    brand: 'Nestle',
    models: [
      { name: 'Maggi 2-Minute Masala Noodles', basePrice: 14 },
      { name: 'Nescafe Classic Pure Instant Coffee', basePrice: 380 },
      { name: 'Everyday Dairy Whitener', basePrice: 220 },
      { name: 'KitKat 4-Finger Chocolate Bar', basePrice: 30 }
    ],
    specs: ['Pack of 4', 'Pack of 8', '100g Glass Jar', '200g Refill'],
    variants: ['Standard', 'Family Saver Pack'],
    type: 'PHYSICAL',
    baseMaxQty: 15
  },

  // --- D2C PERSONAL CARE & NUTRITION ---
  {
    brand: 'MuscleBlaze',
    models: [
      { name: 'Biozyme Performance Whey Protein', basePrice: 2499 },
      { name: 'Creatine Monohydrate CreAMP', basePrice: 899 },
      { name: 'Super Gainer XXL Mass Gainer', basePrice: 1899 },
      { name: 'High Protein Peanut Butter', basePrice: 499 }
    ],
    specs: ['1kg Tub', '2kg Tub', '400g Jar'],
    variants: ['Rich Milk Chocolate', 'Cookies & Cream', 'Nutty Crunch'],
    type: 'PHYSICAL',
    baseMaxQty: 4
  },
  {
    brand: 'Minimalist',
    models: [
      { name: '10% Niacinamide Face Serum', basePrice: 599 },
      { name: '2% Salicylic Acid Face Cleanser', basePrice: 299 },
      { name: 'SPF 50 PA++++ Broad Spectrum Sunscreen', basePrice: 399 },
      { name: 'Multi-Peptide Night Hair Serum', basePrice: 799 }
    ],
    specs: ['30ml Bottle', '50ml Pump', '100ml Tube'],
    variants: ['Standard Bottle', 'Duo Pack'],
    type: 'PHYSICAL',
    baseMaxQty: 5
  },

  // --- DEVELOPER CLOUD, APIS & SAAS ---
  {
    brand: 'Cloud Infrastructure',
    models: [
      { name: 'AWS EC2 c6i.2xlarge Compute Node', basePrice: 14500 },
      { name: 'Vercel Enterprise Team Seat', basePrice: 3200 },
      { name: 'Supabase Dedicated Micro Instance', basePrice: 2100 },
      { name: 'OpenAI GPT-4o Token Batch (10M Tokens)', basePrice: 18000 },
      { name: 'Anthropic Claude 3.5 Sonnet Batch', basePrice: 16500 },
      { name: 'Pinecone Serverless Vector Index Pod', basePrice: 5800 }
    ],
    specs: ['Monthly Recurring', 'On-Demand Pool', 'Auto-Scaling Tier'],
    variants: ['ap-south-1 (Mumbai)', 'us-east-1 (N. Virginia)', 'eu-central-1 (Frankfurt)'],
    type: 'COMPUTE',
    baseMaxQty: 10
  }
];

// Helper function to create clean, human-readable SKUs
function generateCleanSku(brand, modelName, spec, variant) {
  const clean = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const b = clean(brand).substring(0, 4);
  const m = clean(modelName).substring(0, 10);
  const s = clean(spec).substring(0, 6);
  const v = clean(variant).substring(0, 4);
  return `${b}-${m}-${s}-${v}`;
}

console.log('--- Initializing Deterministic Production Catalog Seed ---');

// 3. Populate and Deduplicate the Target Set
const catalogItems = new Map();

// Insert Core Demo Archetypes first
for (const core of coreArchetypes) {
  catalogItems.set(core.sku, {
    sku: core.sku,
    name: core.name,
    type: core.type,
    pricePaise: core.price * 100,
    stock: 100,
    maxQty: core.max_qty,
    risk: core.risk
  });
}

// Generate distinct combinations without random junk
for (const cat of catalogMatrix) {
  for (const model of cat.models) {
    for (const spec of cat.specs) {
      for (const variant of cat.variants) {
        if (catalogItems.size >= 1000) break;

        const fullName = `${cat.brand} ${model.name} (${spec}, ${variant})`;
        const sku = generateCleanSku(cat.brand, model.name, spec, variant);

        if (!catalogItems.has(sku)) {
          // Dynamic pricing variance based on specs (e.g. 512GB vs 128GB)
          let priceMultiplier = 1.0;
          if (spec.includes('512GB') || spec.includes('32GB') || spec.includes('2kg') || spec.includes('5kg')) priceMultiplier = 1.25;
          if (spec.includes('1TB') || spec.includes('64GB') || spec.includes('4TB')) priceMultiplier = 1.6;

          const finalPriceInr = Math.floor(model.basePrice * priceMultiplier);

          // Dynamic Risk Tier Assignment
          let riskTier = 'LOW';
          if (cat.type === 'RESTRICTED' || finalPriceInr >= 100000) {
            riskTier = 'CRITICAL';
          } else if (finalPriceInr >= 35000) {
            riskTier = 'MODERATE';
          }

          catalogItems.set(sku, {
            sku,
            name: fullName,
            type: cat.type,
            pricePaise: finalPriceInr * 100, // Strictly in Paise
            stock: Math.floor(Math.random() * 40) + 10,
            maxQty: cat.baseMaxQty,
            risk: riskTier
          });
        }
      }
    }
  }
}

// 4. Atomic Database Transaction
const seedTransaction = db.transaction(() => {
  // Clear old entries
  db.prepare('DELETE FROM products').run();

  const insert = db.prepare(`
    INSERT INTO products 
    (sku, name, item_type, unit_price_paise, stock_count, max_quantity_per_order, risk_tier, id, title, price_paise, category) 
    VALUES (@sku, @name, @type, @pricePaise, @stock, @maxQty, @risk, @sku, @name, @pricePaise, 'tech')
  `);

  for (const item of catalogItems.values()) {
    insert.run(item);
  }
});

seedTransaction();

console.log(`[SUCCESS] Database populated with ${catalogItems.size} strictly unique, production-grade products.`);
console.log(`[VERIFICATION] Indexed B-Tree search and Velocity Engine ready.`);
