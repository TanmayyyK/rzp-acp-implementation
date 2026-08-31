#!/bin/bash
node src/server.js > server.log 2>&1 &
SERVER_PID=$!
sleep 3

echo -e "\n\n=== 3. Alternative Test Out-of-Order Session Transition ==="
curl -s -i -X POST http://localhost:3000/api/v1/checkout/sessions/RAW_UNCONFIRMED_SESSION_ID/complete \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test_key_123"

kill $SERVER_PID
