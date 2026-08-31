const { checkVelocity, recordSpend } = require('../src/lib/velocityTracker');
recordSpend('usr_alice', 29990000);
console.log(checkVelocity('usr_alice', 29990000, 50000000, 3600000));
