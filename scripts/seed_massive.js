const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, '../data/products.db');
const db = new Database(dbPath);

const categories = {
  electronics: {
    brands: ['Sony', 'Samsung', 'Apple', 'Dell', 'LG', 'Logitech', 'Razer', 'Asus', 'Bose', 'Anker'],
    types: ['Laptop', 'Smartphone', 'Tablet', 'Smartwatch', 'Headphones', 'Monitor', 'Keyboard', 'Mouse', 'Speaker', 'Power Bank', 'Charger', 'TV', 'Microphone', 'Camera'],
    adjectives: ['Wireless', 'Bluetooth', '4K HD', 'Ultra Slim', 'Gaming', 'Noise Cancelling', 'Fast Charging', 'Portable', 'Smart', 'Pro', 'Elite', 'Magnetic']
  },
  home_kitchen: {
    brands: ['Philips', 'Bosch', 'Dyson', 'Prestige', 'Pigeon', 'KitchenAid', 'Tupperware', 'IKEA', 'Milton', 'Cello'],
    types: ['Blender', 'Coffee Maker', 'Air Fryer', 'Vacuum Cleaner', 'Water Purifier', 'Cookware Set', 'Dinner Set', 'Bedsheet', 'Lamp', 'Curtains', 'Pan'],
    adjectives: ['Stainless Steel', 'Non-Stick', 'Automatic', 'Energy Efficient', 'Cotton', 'Modern', 'Compact', 'Heavy Duty', 'Ergonomic', 'Premium']
  },
  fashion: {
    brands: ['Nike', 'Adidas', 'Puma', 'Levi s', 'H&M', 'Zara', 'Ray-Ban', 'Fossil', 'Casio', 'Samsonite'],
    types: ['T-Shirt', 'Jeans', 'Sneakers', 'Jacket', 'Watch', 'Sunglasses', 'Backpack', 'Wallet', 'Dress', 'Running Shoes'],
    adjectives: ['Cotton', 'Slim Fit', 'Casual', 'Classic', 'Waterproof', 'Leather', 'Vintage', 'Sports', 'Breathable', 'Stylish']
  },
  beauty: {
    brands: ['L Oreal', 'Maybelline', 'MAC', 'Clinique', 'Dove', 'Nivea', 'Gillette', 'Olay', 'Lakme', 'Neutrogena'],
    types: ['Face Wash', 'Moisturizer', 'Lipstick', 'Foundation', 'Perfume', 'Shampoo', 'Conditioner', 'Sunscreen', 'Serum', 'Body Lotion'],
    adjectives: ['Hydrating', 'Anti-Aging', 'Matte', 'SPF 50', 'Organic', 'Vitamin C', 'Aloe Vera', 'Deep Cleansing', 'Long Lasting', 'Natural']
  },
  sports: {
    brands: ['Decathlon', 'Yonex', 'Nivia', 'Cosco', 'Spalding', 'Wilson', 'Gatorade', 'Speedo', 'Kipsta', 'Quechua'],
    types: ['Yoga Mat', 'Dumbbells', 'Football', 'Badminton Racket', 'Water Bottle', 'Tent', 'Resistance Bands', 'Protein Powder', 'Skipping Rope', 'Gym Bag'],
    adjectives: ['Anti-Slip', 'Adjustable', 'Pro', 'Heavyweight', 'Stainless Steel', 'Waterproof', 'Durable', 'Lightweight', 'Training', 'Professional']
  },
  grocery: {
    brands: ['Nescafe', 'Lays', 'Oreo', 'Kelloggs', 'Maggi', 'Nutella', 'Tropicana', 'Amul', 'Tata', 'Kissan'],
    types: ['Coffee', 'Potato Chips', 'Cookies', 'Corn Flakes', 'Instant Noodles', 'Hazelnut Spread', 'Fruit Juice', 'Butter', 'Tea', 'Jam'],
    adjectives: ['Instant', 'Classic', 'Crunchy', 'Healthy', 'Spicy', 'Sweet', 'Fresh', 'Premium', 'Organic', 'Natural']
  }
};

const insert = db.prepare(`
  INSERT INTO products (id, title, description, price_paise, availability, category, image_url)
  VALUES (@id, @title, @description, @price_paise, @availability, @category, @image_url)
`);

let inserted = 0;

db.transaction(() => {
  for (const [catName, catData] of Object.entries(categories)) {
    for (let i = 0; i < 350; i++) { // 350 per category * 6 = 2100 total
      const brand = catData.brands[Math.floor(Math.random() * catData.brands.length)];
      const type = catData.types[Math.floor(Math.random() * catData.types.length)];
      const adj1 = catData.adjectives[Math.floor(Math.random() * catData.adjectives.length)];
      
      let adj2 = catData.adjectives[Math.floor(Math.random() * catData.adjectives.length)];
      while(adj1 === adj2) adj2 = catData.adjectives[Math.floor(Math.random() * catData.adjectives.length)];

      const title = `${brand} ${adj1} ${type}`;
      const description = `High quality ${adj2.toLowerCase()} ${type.toLowerCase()} by ${brand}. Perfect for daily use and extremely reliable.`;
      
      // Price between ₹100 and ₹50,000
      let price_rupees = Math.floor(Math.random() * 4900) + 100; 
      if (catName === 'grocery') price_rupees = Math.floor(Math.random() * 900) + 50;
      const price_paise = price_rupees * 100;
      
      const availability = Math.random() > 0.05 ? 1 : 0;
      const id = `prod_${catName.substring(0,3)}_${Math.random().toString(36).substring(2, 10)}`;
      const image_url = `https://dummyimage.com/400x400/eeeeee/333333&text=${encodeURIComponent(type.split(' ')[0])}`;

      insert.run({
        id,
        title,
        description,
        price_paise,
        availability,
        category: catName,
        image_url
      });
      inserted++;
    }
  }
})();

console.log(`Successfully generated and inserted ${inserted} massive products into the database.`);
