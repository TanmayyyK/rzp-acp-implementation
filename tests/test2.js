const app = require('../src/server.js');
const { createMerchantTools } = require('../src/mcp/merchantClient');
const { sharedAuditLog } = require('../src/lib/auditLog');
async function run() {
  const server = require('http').createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const tools = createMerchantTools({ baseUrl: `http://127.0.0.1:${server.address().port}`, auditLog: sharedAuditLog, fetchImpl: global.fetch });
  try {
    const cart = await tools.create_cart({ items: [{product_id: 'prod_elec_007', quantity: 1}]});
    console.log('Cart created:', cart.session_id);
    const res = await tools.complete_checkout({ session_id: cart.session_id });
    console.log('Checkout completed:', res);
  } catch(e) { console.error('Error:', e); }
  server.close();
}
run();
