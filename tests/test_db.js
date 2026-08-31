const db = require('../src/db.js');
console.log(db.prepare('SELECT budget_cap_paise FROM users WHERE principal_id = ?').get('usr_alice'));
