/**
 * Sets all required Cloudflare Worker secrets from the service account file.
 * Run: node scripts/set-secrets.js
 * Requires CLOUDFLARE_API_TOKEN env var to be set.
 */
const { execSync } = require('child_process');
const fs  = require('fs');
const path = require('path');

const SA_PATH = '/tmp/sa.json';

if (!fs.existsSync(SA_PATH)) {
  console.error('Service account file not found at /tmp/sa.json');
  process.exit(1);
}

const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));

function setSecret(name, value) {
  console.log(`Setting ${name}...`);
  execSync(
    `printf '%s' '${value.replace(/'/g, "'\\''")}' | npx wrangler secret put ${name}`,
    { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'inherit', 'inherit'] },
  );
  console.log(`✓ ${name}`);
}

setSecret('FIREBASE_PRIVATE_KEY',  sa.private_key);
setSecret('FIREBASE_CLIENT_EMAIL', sa.client_email);
setSecret('ADMIN_PIN', '1414');   // set from known value — do not print
console.log('\nAll secrets set.');
