const sharp = require('sharp');

const WIDTH = 1920;
const HEIGHT = 1080;

/**
 * Builds the darkening/legibility overlay as an SVG gradient, rasterized by sharp.
 * Netflix-style treatment: light vignette overall + a stronger bottom-left gradient
 * so the profile rail (rendered by Nuvio itself, top-left) and any title logo we
 * stamp on stay readable against a bright backdrop.
 */
function buildOverlaySvg({ width = WIDTH, height = HEIGHT, strength = 0.72 } = {}) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="0" />
          <stop offset="40%" stop-color="black" stop-opacity="${0.35 * strength}" />
          <stop offset="100%" stop-color="black" stop-opacity="${0.97 * strength}" />
        </linearGradient>
        <linearGradient id="left" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="black" stop-opacity="${0.88 * strength}" />
          <stop offset="30%" stop-color="black" stop-opacity="${0.55 * strength}" />
          <stop offset="55%" stop-color="black" stop-opacity="${0.12 * strength}" />
          <stop offset="75%" stop-color="black" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="${0.4 * strength}" />
          <stop offset="25%" stop-color="black" stop-opacity="0" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="black" opacity="${0.4 * strength}" />
      <rect width="${width}" height="${height}" fill="url(#bottom)" />
      <rect width="${width}" height="${height}" fill="url(#left)" />
      <rect width="${width}" height="${height}" fill="url(#top)" />
    </svg>
  `);
}

/**
 * Composites: backdrop (cropped to fill) -> darkening overlay -> title logo
 * (bottom-right, off-centre so it never collides with Nuvio's own profile list
 * which sits top/mid-left on the TV screen).
 *
 * @param {Buffer} backdropBuffer - raw backdrop image bytes (jpg/png)
 * @param {Buffer|null} logoBuffer - raw transparent logo bytes (png), optional
 * @param {object} opts
 */
async function composeBackground(backdropBuffer, logoBuffer, opts = {}) {
  const width = opts.width || WIDTH;
  const height = opts.height || HEIGHT;
  const overlayStrength = opts.overlayStrength ?? 0.72;
  const logoMaxWidthFrac = opts.logoMaxWidthFrac ?? 0.24; // logo width as fraction of canvas
  const marginFrac = opts.marginFrac ?? 0.045; // margin from right/bottom edges

  const backdrop = await sharp(backdropBuffer)
    .resize(width, height, { fit: 'cover', position: 'attention' })
    .toBuffer();

  const overlay = buildOverlaySvg({ width, height, strength: overlayStrength });

  const composites = [{ input: overlay, top: 0, left: 0 }];

  if (logoBuffer) {
    const logoMaxWidth = Math.round(width * logoMaxWidthFrac);
    const logoMaxHeight = Math.round(height * 0.16);

    const resizedLogo = await sharp(logoBuffer)
      .resize(logoMaxWidth, logoMaxHeight, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();

    const meta = await sharp(resizedLogo).metadata();
    const marginX = Math.round(width * marginFrac);
    const marginY = Math.round(height * marginFrac * 1.4);

    composites.push({
      input: resizedLogo,
      left: width - meta.width - marginX,
      top: height - meta.height - marginY,
    });
  }

  return sharp(backdrop)
    .composite(composites)
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

module.exports = { composeBackground, buildOverlaySvg, WIDTH, HEIGHT };
