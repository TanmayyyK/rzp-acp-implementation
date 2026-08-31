const { sharedAuditLog } = require('./src/lib/auditLog');
const { createMerchantTools } = require('./src/mcp/merchantClient');

async function run() {
  // Pass dummy params so the module doesn't crash on fetch / audit
  const tools = createMerchantTools({ 
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    origin: 'http://localhost',
    auditLog: sharedAuditLog
  });
  
  try {
    await tools.create_cart({
      budget_in_rupees: 50000,
      items: [{product_id: 'prod_123', quantity: 1}]
    });
  } catch(e) {
    // ignore
  }
  
  const entries = sharedAuditLog.entries();
  const ignored = entries.find(e => e.payload && e.payload.note === 'IGNORED_AGENT_SUPPLIED_LIMIT');
  if (ignored) {
    console.log("SUCCESS! Found IGNORED_AGENT_SUPPLIED_LIMIT in audit log");
    console.log("Supplied budget:", ignored.payload.supplied);
  } else {
    console.log("FAILED to find audit log entry");
    console.log(entries);
  }
}
run();
