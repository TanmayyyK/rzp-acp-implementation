#!/bin/bash
node src/server.js > server.log 2>&1 &
SERVER_PID=$!
sleep 2

curl -v http://127.0.0.1:3000/api/v1/products

kill $SERVER_PID
