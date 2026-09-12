const sharp = require('sharp');
const path = require('path');

async function main() {
  // Synthetic "backdrop": a bright, busy-ish photo stand-in so we can see if the
  // overlay actually darkens it enough to read text/logo over it.
  const backdropSvg = Buffer.from(`
    <svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#f2d94e" />
          <stop offset="50%" stop-color="#ff8a3d" />
          <stop offset="100%" stop-color="#e5484d" />
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill="url(#bg)" />
      <circle cx="500" cy="300" r="220" fill="#ffffff" opacity="0.4" />
      <circle cx="1400" cy="700" r="300" fill="#000000" opacity="0.15" />
    </svg>
  `);
  await sharp(backdropSvg).jpeg().toFile(path.join(__dirname, 'fake-backdrop.jpg'));

  // Synthetic "logo": white wordmark-ish shape on transparent background.
  const logoSvg = Buffer.from(`
    <svg width="600" height="180" xmlns="http://www.w3.org/2000/svg">
      <text x="0" y="120" font-family="Arial, sans-serif" font-size="110" font-weight="900" fill="white">SHOW</text>
    </svg>
  `);
  await sharp(logoSvg).png().toFile(path.join(__dirname, 'fake-logo.png'));

  console.log('wrote fake-backdrop.jpg and fake-logo.png');
}

main().catch((e) => { console.error(e); process.exit(1); });
