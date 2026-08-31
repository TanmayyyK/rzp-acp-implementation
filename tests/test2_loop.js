const app = require('../src/server.js');
const { createMerchantTools } = require('../src/mcp/merchantClient');
const { sharedAuditLog } = require('../src/lib/auditLog');
async function run() {
  const server = require('http').createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const tools = createMerchantTools({ baseUrl: `http://127.0.0.1:${server.address().port}`, auditLog: sharedAuditLog, fetchImpl: global.fetch });
  for(let i=0; i<6; i++) {
    try {
      const cart = await tools.create_cart({ items: [{product_id: 'prod_elec_007', quantity: 1}]});
      const res = await tools.complete_checkout({ session_id: cart.session_id });
      console.log(`[${i+1}] Checkout completed:`, res.state);
    } catch(e) { console.error(`[${i+1}] Error:`, e.message); }
  }
  server.close();
}
run();
