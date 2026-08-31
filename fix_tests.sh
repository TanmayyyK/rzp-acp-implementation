sed -i '' -e 's/await request(app)/await request(app).post(\"\/_test\/login\"); await request(app)/g' tests/checkout.test.js
