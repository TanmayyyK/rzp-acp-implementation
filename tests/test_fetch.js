const app = require('../src/server.js');
const server = app.listen(0);
const port = server.address().port;
console.log('Listening on port', port);
fetch(`http://127.0.0.1:${port}/api/v1/products`)
  .then(res => res.json())
  .then(console.log)
  .catch(console.error)
  .finally(() => server.close());
