const fs = require('fs');
const path = require('path');
const { composeBackground } = require('../lib/compose');

async function main() {
  const backdrop = fs.readFileSync(path.join(__dirname, 'fake-backdrop.jpg'));
  const logo = fs.readFileSync(path.join(__dirname, 'fake-logo.png'));

  const out = await composeBackground(backdrop, logo, {});
  fs.writeFileSync(path.join(__dirname, 'preview.jpg'), out);
  console.log('wrote test/preview.jpg', out.length, 'bytes');
}

main().catch((e) => { console.error(e); process.exit(1); });
