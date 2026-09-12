const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { composeBackground } = require('../lib/compose');

async function main() {
  const backdrop = fs.readFileSync(path.join(__dirname, 'fake-backdrop.jpg'));
  const logo = fs.readFileSync(path.join(__dirname, 'fake-logo.png'));

  const before = await composeBackground(backdrop, logo, {
    logoMaxWidthFrac: 0.24,
    logoMaxHeightFrac: 0.16,
    logoOpacity: 1,
  });
  const after = await composeBackground(backdrop, logo, {}); // new defaults

  fs.writeFileSync(path.join(__dirname, 'verify-logo-before.jpg'), before);
  fs.writeFileSync(path.join(__dirname, 'verify-logo-after.jpg'), after);

  // Crop the bottom-right quadrant of each (where the logo sits) for an easy
  // side-by-side look, and stitch them together.
  const cropW = 700, cropH = 350;
  const beforeCrop = await sharp(before).extract({ left: 1920 - cropW, top: 1080 - cropH, width: cropW, height: cropH }).toBuffer();
  const afterCrop = await sharp(after).extract({ left: 1920 - cropW, top: 1080 - cropH, width: cropW, height: cropH }).toBuffer();

  const labelSvg = (text) => Buffer.from(`
    <svg width="${cropW}" height="30" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="black"/>
      <text x="10" y="21" font-family="sans-serif" font-size="18" fill="white">${text}</text>
    </svg>
  `);

  const beforeLabeled = await sharp(beforeCrop).composite([{ input: labelSvg('BEFORE'), top: 0, left: 0 }]).toBuffer();
  const afterLabeled = await sharp(afterCrop).composite([{ input: labelSvg('AFTER') , top: 0, left: 0 }]).toBuffer();

  const combined = await sharp({
    create: { width: cropW, height: (cropH + 30) * 2 + 10, channels: 3, background: '#111' },
  })
    .composite([
      { input: beforeLabeled, top: 0, left: 0 },
      { input: afterLabeled, top: cropH + 40, left: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  fs.writeFileSync(path.join(__dirname, 'verify-logo-comparison.jpg'), combined);
  console.log('wrote test/verify-logo-comparison.jpg');

  // Numeric sanity check: logo footprint and mean alpha.
  const oldLogo = await sharp(logo).resize(Math.round(1920 * 0.24), Math.round(1080 * 0.16), { fit: 'inside', withoutEnlargement: true }).toBuffer();
  const newLogo = await sharp(logo).resize(Math.round(1920 * 0.168), Math.round(1080 * 0.112), { fit: 'inside', withoutEnlargement: true }).toBuffer();
  const oldMeta = await sharp(oldLogo).metadata();
  const newMeta = await sharp(newLogo).metadata();
  console.log(`old logo size: ${oldMeta.width}x${oldMeta.height}`);
  console.log(`new logo size: ${newMeta.width}x${newMeta.height} (${Math.round((1 - (newMeta.width * newMeta.height) / (oldMeta.width * oldMeta.height)) * 100)}% smaller by area)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
