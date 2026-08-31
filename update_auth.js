const fs = require('fs');
const file = 'src/routes/auth.js';
let content = fs.readFileSync(file, 'utf8');

const oldQuery = `db.prepare(\`
        INSERT INTO webauthn_credentials (principal_id, credential_id, public_key, counter, transports)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(principal_id) DO UPDATE SET
          credential_id=excluded.credential_id,
          public_key=excluded.public_key,
          counter=excluded.counter,
          transports=excluded.transports
      \`).run(
        principal_id,
        credentialID,
        credentialPublicKey,
        counter,
        transports ? JSON.stringify(transports) : null
      );`;

const newQuery = `try {
        db.prepare(\`
          INSERT INTO webauthn_credentials (principal_id, credential_id, public_key, counter, transports)
          VALUES (?, ?, ?, ?, ?)
        \`).run(
          principal_id,
          credentialID,
          credentialPublicKey,
          counter,
          transports ? JSON.stringify(transports) : null
        );
      } catch (err) {
        if (err.code && err.code.startsWith('SQLITE_CONSTRAINT')) {
          return res.status(409).json({ error: 'Credential already exists for this principal' });
        }
        throw err;
      }`;

if (content.includes(oldQuery)) {
  content = content.replace(oldQuery, newQuery);
  fs.writeFileSync(file, content);
  console.log('auth.js updated successfully.');
} else {
  console.log('Could not find the target code in auth.js.');
}
