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
 * Escapes the handful of characters that would break well-formed SVG text
 * content. Genre names and rank numbers are our own hardcoded/numeric data,
 * not arbitrary user input, but this is cheap insurance.
 */
function escapeSvgText(str) {
  return String(str).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
}

/**
 * Builds the genre/trend tag row as a full-canvas SVG, right-anchored under
 * the logo — same "text-anchor=end at a fixed x" trick as the rest of this
 * file's SVG layers, so no post-render width measurement/fit:'inside' is
 * needed to keep it flush with the logo's right edge (see composeBackground
 * for why that matters). Netflix-inspired, deliberately not a copy: TMDB
 * only gives us blunt genres (no curated mood tags like "Soapy"), and the
 * trend line uses its own gold/amber accent rather than Netflix red.
 *
 * Two possible lines, bottom-up: genre row (e.g. "ACTION · ADVENTURE ·
 * FANTASY") sits lowest, closest to the same margin the logo alone used to
 * sit at; an optional trend row ("NO. 4 TRENDING TODAY") sits above it. Note
 * the rank itself is this week's trending-list position (see fetchPoolFresh
 * in lib/tmdb.js), reused as-is rather than fetching a separate trending/day
 * list — "TODAY" is a wording choice Charles asked for, not a literal claim.
 * Either can be omitted independently (an item may have genres but no
 * trend rank, or vice versa in principle).
 */
function buildTagsSvg({
  width, height, marginX, baseMarginY, genreNames = [], trendRank = null,
  tagsFontSize, trendFontSize, lineGap,
} = {}) {
  const rightX = width - marginX;
  const elements = [];
  let y = height - baseMarginY;

  if (genreNames.length) {
    const text = genreNames.map((g) => g.toUpperCase()).join('   ·   ');
    elements.push(
      `<text x="${rightX}" y="${y}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" ` +
      `font-size="${tagsFontSize}" font-weight="600" letter-spacing="1.5" fill="#e8e8e8" fill-opacity="0.88">` +
      `${escapeSvgText(text)}</text>`
    );
    y -= tagsFontSize + Math.round(lineGap * 0.6);
  }

  if (trendRank) {
    const text = `NO. ${trendRank.rank} TRENDING TODAY`;
    elements.push(
      `<text x="${rightX}" y="${y}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" ` +
      `font-size="${trendFontSize}" font-weight="700" letter-spacing="1.8" fill="#f5c451" fill-opacity="0.95">` +
      `${escapeSvgText(text)}</text>`
    );
  }

  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${elements.join('')}</svg>`);
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
 * the needle at all — a bad trade against "stay light." The actual cause of
 * both the blockiness and a separate "just plain blurry" complaint was
 * upstream: see BACKDROP_SIZE in api/background.js — requesting TMDB's
 * w1280 backdrop meant every image got upscaled ~1.5x to fill this 1920x1080
 * canvas before blur even ran, and upscaling is inherently soft/blocky.
 * Sept 14 fix: BACKDROP_SIZE defaults to "original" now (no more upscale,
 * sharp only ever downsamples), blurSigma dropped from 1.2-1.4 to a barely-
 * there 0.6, and a sharpen pass (see `sharpen` below) counters the residual
 * softness from the resize/re-encode — net result reads noticeably crisper
 * at a similar-order-of-magnitude file size (verified A/B, not just in
 * theory).
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
  // Very light blur only, to settle flat-gradient JPEG quantization in dark
  // scenes; anything much above this measurably softens the whole frame (see
  // BLUR_SIGMA in api/background.js). Readability under the text/profile row
  // comes mainly from the darkening overlay above, not from blurring detail.
  const blurSigma = opts.blurSigma ?? 0.6;
  const jpegQuality = opts.jpegQuality ?? 86;
  // Counters the softness a cover-fit resize/JPEG re-encode naturally
  // introduces, so a downsampled "original"-size source still reads crisp.
  const sharpen = opts.sharpen ?? true;

  // Genre/trend tag row, under the logo. Both optional and independent; the
  // whole block collapses to zero height (identical layout to before this
  // feature existed) when neither is supplied, e.g. pools other than
  // 'trending' that carry no trend rank, or an item TMDB returned with no
  // genre_ids at all.
  const genreNames = Array.isArray(opts.genreNames) ? opts.genreNames.filter(Boolean).slice(0, 3) : [];
  const trendRank = opts.trendRank || null;
  const showTags = genreNames.length > 0 || !!trendRank;
  const tagsFontSize = opts.tagsFontSize ?? Math.round(height * 0.021);
  const trendFontSize = opts.trendFontSize ?? Math.round(height * 0.018);
  const tagsLineGap = opts.tagsLineGap ?? Math.round(height * 0.014);

  const [uiZoneBrightness, resizedBackdrop] = await Promise.all([
    measureUiZoneBrightness(backdropBuffer, { width, height }),
    (async () => {
      let pipeline = sharp(backdropBuffer).resize(width, height, { fit: 'cover', position: 'attention' });
      if (sharpen) pipeline = pipeline.sharpen();
      if (blurSigma > 0) pipeline = pipeline.blur(blurSigma);
      return pipeline.toBuffer();
    })(),
  ]);

  const overlayStrength = resolveOverlayStrength(baseOverlayStrength, uiZoneBrightness);
  const overlay = buildOverlaySvg({ width, height, strength: overlayStrength });

  const composites = [{ input: overlay, top: 0, left: 0 }];

  const marginX = Math.round(width * marginFrac);
  const baseMarginY = Math.round(height * marginFrac * 1.4);

  // Tags render below the logo, so the whole [logo, tags] stack has to sit
  // with its bottom at the same margin the logo alone used to sit at —
  // meaning the logo itself moves up by the tag block's height when tags are
  // present, rather than the tags encroaching on the existing bottom margin.
  let tagsBlockHeight = 0;
  if (showTags) {
    if (genreNames.length) tagsBlockHeight += tagsFontSize;
    if (trendRank) tagsBlockHeight += trendFontSize + Math.round(tagsLineGap * 0.6);
    tagsBlockHeight += tagsLineGap;
  }
  const logoMarginY = baseMarginY + tagsBlockHeight;

  if (logoBuffer) {
    const logoMaxWidth = Math.round(width * logoMaxWidthFrac);
    const logoMaxHeight = Math.round(height * logoMaxHeightFrac);

    // TMDB clearlogos are typically delivered on a canvas with transparent
    // padding around the actual wordmark (varies title to title), so sizing
    // off the raw asset's own width/height put the *canvas* flush against
    // the right margin, not the visible glyph — which reads as misaligned
    // against the tag text underneath, whose SVG bounding box has no such
    // padding. Trimming the transparent border first means meta.width below
    // is the real visible width, so "flush right" means the same thing for
    // both layers. Falls back to the untrimmed buffer if trim ever throws
    // (e.g. a logo with no uniform border to detect).
    const trimmedLogo = await sharp(logoBuffer).trim().toBuffer().catch(() => logoBuffer);

    const resizedLogo = await sharp(trimmedLogo)
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

    composites.push({
      input: finalLogo,
      left: width - meta.width - marginX,
      top: height - meta.height - logoMarginY,
    });
  }

  if (showTags) {
    composites.push({
      input: buildTagsSvg({
        width, height, marginX, baseMarginY, genreNames, trendRank,
        tagsFontSize, trendFontSize, lineGap: tagsLineGap,
      }),
      top: 0,
      left: 0,
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
  buildTagsSvg,
  measureUiZoneBrightness,
  resolveOverlayStrength,
  WIDTH,
  HEIGHT,
};
