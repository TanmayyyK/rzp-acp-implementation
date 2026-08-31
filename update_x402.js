const fs = require('fs');
const file = 'src/routes/x402.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace('let reservation;', 'let reservationId;');
content = content.replace('reservation = await reserveSpend(principal_id', 'reservationId = await reserveSpend(principal_id');
content = content.replace(/commitSpend\(reservation\);/g, 'commitSpend(principal_id, reservationId);');
content = content.replace(/releaseSpend\(reservation\);/g, 'releaseSpend(principal_id, reservationId);');

fs.writeFileSync(file, content);
console.log('x402.js updated.');
