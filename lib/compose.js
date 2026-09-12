const sharp = require('sharp');

const WIDTH = 1920;
const HEIGHT = 1080;

// The vertical fraction of the canvas where Nuvio draws its own UI (profile
// row, "Select a profile" / "Hold to manage profile" text). Measured off a
// real screenshot of the picker.
const UI_ZONE_TOP_FRAC = 0.32;

// Target mean luminance (0-255) we want left in that zone after darkening.
// Nuvio's white text needs the backdrop well below mid-grey to stay legible.
const TARGET_UI_LUMINANCE = 65;

/**
 * Downsamples the backdrop and measures mean luminance in the zone where
 * Nuvio's own text/UI renders, so a bright poster (snow, daylight, white
 * sky) gets darkened more than a moody dark one instead of both getting the
 * same fixed overlay. This is a single cheap resize + stats call on a tiny
 * image, not a full-resolution pass — negligible cost.
 */
async function measureUiZoneBrightness(backdropBuffer, { width = WIDTH, height = HEIGHT } = {}) {
  const sampleW = 64;
  const sampleH = 36;
  const zoneTopPx = Math.round(sampleH * UI_ZONE_TOP_FRAC);

  const { data, info } = await sharp(backdropBuffer)
    .resize(sampleW, sampleH, { fit: 'cover', position: 'attention' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rowBytes = info.width * info.channels;
  let sum = 0;
  let count = 0;
  for (let y = zoneTopPx; y < info.height; y++) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < info.width; x++) {
      sum += data[rowStart + x * info.channels];
      count++;
    }
  }
  return count ? sum / count : 128;
}

/**
 * Builds the darkening/legibility overlay as an SVG gradient, rasterized by
 * sharp. Netflix-style treatment: light vignette overall + a stronger
 * bottom-left gradient. The left gradient's falloff now reaches all the way
 * to the right edge (previously it fully cleared by 75% width), because the
 * old shape left the right two-thirds of the UI band — where Nuvio's text
 * and "Add Profile" actually sit — under-darkened against bright backdrops.
 * `strength` is expected to already be the brightness-adjusted value (see
 * `resolveOverlayStrength`), so this function stays a pure "shape" builder.
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
          <stop offset="60%" stop-color="black" stop-opacity="${0.28 * strength}" />
          <stop offset="100%" stop-color="black" stop-opacity="${0.12 * strength}" />
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
 * Scales the base overlay strength up when the UI zone measures brighter
 * than our legibility target — a single scalar applied to the whole
 * gradient shape, so areas the shape already darkens heavily don't get a
 * second, uncorrelated darkening layer stacked on top (that was crushing
 * the bottom-left corner to near-pure-black while barely helping the
 * brighter parts of the frame). Capped so we never fully black out the
 * image even on a pure-white backdrop.
 */
function resolveOverlayStrength(baseStrength, uiZoneBrightness) {
  const overBudget = Math.max(0, uiZoneBrightness - TARGET_UI_LUMINANCE) / (255 - TARGET_UI_LUMINANCE);
  const boost = overBudget * 0.6; // up to +0.6 strength on the brightest backdrops
  return Math.min(1.35, baseStrength + boost);
}

/**
 * Composites: backdrop (cropped to fill, lightly blurred) -> darkening
 * overlay (adaptive to the backdrop's own brightness) -> title logo
 * (bottom-right, off-centre so it never collides with Nuvio's own profile
 * list which sits top/mid-left on the TV screen).
 *
 * A note on the dark-scene "pixelation" complaint specifically: an SVG
 * grain/dither layer was tried here to combat JPEG's blocky quantization in
 * flat near-black gradients (the standard fix for this class of artifact).
 * Measured against a pristine baseline it either did nothing detectable at
 * an output-size-neutral opacity, or needed 2-4x the output bytes to move
 * the needle at all — a bad trade against "stay light." The more likely
 * actual cause of visible blockiness is upstream: see BACKDROP_SIZE in
 * api/background.js, which was requesting an undocumented TMDB size and
 * risked silently upscaling a smaller source into this canvas. That's the
 * fix that's actually in this pipeline; a modest quality bump below (82->84)
 * gives a real, cheap reduction in quantization coarseness on top of it.
 *
 * @param {Buffer} backdropBuffer - raw backdrop image bytes (jpg/png)
 * @param {Buffer|null} logoBuffer - raw transparent logo bytes (png), optional
 * @param {object} opts
 */
async function composeBackground(backdropBuffer, logoBuffer, opts = {}) {
  const width = opts.width || WIDTH;
  const height = opts.height || HEIGHT;
  const baseOverlayStrength = opts.overlayStrength ?? 0.72;
  // Logo footprint, ~30% smaller than the original 0.24/0.16 fractions so it
  // reads as a subtle brand mark rather than competing with the backdrop.
  const logoMaxWidthFrac = opts.logoMaxWidthFrac ?? 0.168; // logo width as fraction of canvas
  const logoMaxHeightFrac = opts.logoMaxHeightFrac ?? 0.112; // logo height as fraction of canvas
  // Clearlogos are typically pure-white/full-alpha PNGs, which read as
  // brighter than any of Nuvio's own UI text once stamped on a darkened
  // backdrop. Dimming the logo's own alpha (not just relying on the overlay)
  // lets it still stand out from the backdrop while staying visibly less
  // bright than Nuvio's own on-screen elements (e.g. "Supporter+").
  const logoOpacity = opts.logoOpacity ?? 0.78;
  const marginFrac = opts.marginFrac ?? 0.045; // margin from right/bottom edges
  // Light blur softens busy detail behind the text/profile row and, as a
  // side effect, lowers JPEG output size (less high-frequency detail to
  // encode) — helps both readability and keeps the response light.
  const blurSigma = opts.blurSigma ?? 1.2;
  const jpegQuality = opts.jpegQuality ?? 84;

  const [uiZoneBrightness, resizedBackdrop] = await Promise.all([
    measureUiZoneBrightness(backdropBuffer, { width, height }),
    (async () => {
      const pipeline = sharp(backdropBuffer).resize(width, height, { fit: 'cover', position: 'attention' });
      return (blurSigma > 0 ? pipeline.blur(blurSigma) : pipeline).toBuffer();
    })(),
  ]);

  const overlayStrength = resolveOverlayStrength(baseOverlayStrength, uiZoneBrightness);
  const overlay = buildOverlaySvg({ width, height, strength: overlayStrength });

  const composites = [{ input: overlay, top: 0, left: 0 }];

  if (logoBuffer) {
    const logoMaxWidth = Math.round(width * logoMaxWidthFrac);
    const logoMaxHeight = Math.round(height * logoMaxHeightFrac);

    const resizedLogo = await sharp(logoBuffer)
      .resize(logoMaxWidth, logoMaxHeight, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();

    const meta = await sharp(resizedLogo).metadata();

    // Scale the logo's own alpha channel down to logoOpacity (a `dest-in`
    // blend against a semi-transparent white mask), so it partially blends
    // with the backdrop underneath instead of stamping at full brightness.
    const finalLogo = logoOpacity >= 1
      ? resizedLogo
      : await sharp(resizedLogo)
          .composite([{
            input: Buffer.from(
              `<svg width="${meta.width}" height="${meta.height}"><rect width="100%" height="100%" fill="white" opacity="${logoOpacity}"/></svg>`
            ),
            blend: 'dest-in',
          }])
          .png()
          .toBuffer();

    const marginX = Math.round(width * marginFrac);
    const marginY = Math.round(height * marginFrac * 1.4);

    composites.push({
      input: finalLogo,
      left: width - meta.width - marginX,
      top: height - meta.height - marginY,
    });
  }

  return sharp(resizedBackdrop)
    .composite(composites)
    .jpeg({ quality: jpegQuality, mozjpeg: true })
    .toBuffer();
}

module.exports = {
  composeBackground,
  buildOverlaySvg,
  measureUiZoneBrightness,
  resolveOverlayStrength,
  WIDTH,
  HEIGHT,
};
