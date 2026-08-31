const app = require('../src/server.js');
const { createMerchantTools } = require('../src/mcp/merchantClient');
const { sharedAuditLog } = require('../src/lib/auditLog');
const db = require('../src/db');

async function run() {
  process.env.AUTO_APPROVE_THRESHOLD_PAISE = '100000000';
  db.prepare('INSERT OR IGNORE INTO users (principal_id, budget_cap_paise) VALUES (?, ?)').run('usr_alice', 50000000);
  db.prepare('UPDATE users SET budget_cap_paise = ? WHERE principal_id = ?').run(50000000, 'usr_alice');

  const server = require('http').createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const tools = createMerchantTools({ baseUrl: `http://127.0.0.1:${server.address().port}`, auditLog: sharedAuditLog, fetchImpl: global.fetch, autoApproveThresholdPaise: 100000000 });
  
  for(let i=0; i<3; i++) {
    try {
      const cart = await tools.create_cart({ items: [{product_id: 'prod_elec_005', quantity: 1}]});
      console.log('Cart created:', cart);
      const res = await tools.complete_checkout({ session_id: cart.session_id });
      console.log(`[${i+1}] Checkout completed:`, res);
    } catch(e) { console.error(`[${i+1}] Error:`, e.message); }
  }
  server.close();
}
run();
