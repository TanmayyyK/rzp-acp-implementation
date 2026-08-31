const app = require('../src/server.js');
const { createMerchantTools } = require('../src/mcp/merchantClient');
const { sharedAuditLog } = require('../src/lib/auditLog');

const server = app.listen(0, async () => {
  const port = server.address().port;
  console.log('Listening on', port);
  const tools = createMerchantTools({ origin: `http://127.0.0.1:${port}`, auditLog: sharedAuditLog });
  try {
    const res = await tools.create_cart({ items: [{ product_id: 'prod_elec_007', quantity: 1 }] });
    console.log(res);
  } catch(e) {
    console.error(e);
  }
  server.close();
});
