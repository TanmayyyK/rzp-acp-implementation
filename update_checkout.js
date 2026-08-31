const fs = require('fs');
const file = 'src/routes/checkout.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace('let reservation;', 'let reservationId;');
content = content.replace('reservation = await reserveSpend', 'reservationId = await reserveSpend');
content = content.replace(/commitSpend\(reservation\);/g, 'commitSpend(principalId, reservationId);');
content = content.replace(/releaseSpend\(reservation\);/g, 'releaseSpend(principalId, reservationId);');

fs.writeFileSync(file, content);
console.log('checkout.js updated.');
