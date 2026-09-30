const sharp = require('sharp');
const { ensureFontsConfigured } = require('./fonts');

// Must run before any SVG-with-text is rasterized (see lib/fonts.js for
// why) — importing this module is enough, everything below runs later.
ensureFontsConfigured();

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

// Title case per Charles's ask (replacing the earlier all-caps styling,
// then briefly sentence case before he asked for every word capitalized):
// lowercase the whole string, then capitalize the first letter of each word.
// \w matches digits too (harmless — toUpperCase on "4" is a no-op) and the
// "·" separator has no word characters of its own, so it's left untouched.
function toTitleCase(str) {
  return String(str).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Per-title accent colour (Sept 30 redesign), taken from the backdrop itself
 * so the highlight label picks up the poster's own mood: amber for a sunset,
 * red for Spider-Man, teal for a sci-fi blue. Downsamples to 48x27, builds a
 * hue histogram weighted by saturation x brightness (so vivid, visible
 * colours win over murky shadows), then re-renders the winning hue at a
 * fixed saturation/lightness that stays legible on the darkened frame.
 * Falls back to a warm gold when the image has no real colour (greyscale,
 * near-black). Cheap: one tiny resize, no full-resolution pass.
 */
const DEFAULT_ACCENT = '#e8c27a';

function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

async function pickAccentColor(imageBuffer, { minCoverage = 0.04 } = {}) {
  try {
    const { data, info } = await sharp(imageBuffer)
      .resize(48, 27, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let opaque = 0;
    const bins = 24;
    const weight = new Array(bins).fill(0);
    const sumX = new Array(bins).fill(0);
    const sumY = new Array(bins).fill(0);
    let total = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3] < 128) continue; // transparent logo padding
      opaque++;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const v = max, s = max ? (max - min) / max : 0;
      if (s < 0.3 || v < 0.2) continue;
      let h;
      const d = max - min;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      const w = s * v;
      const bin = Math.floor(h / (360 / bins)) % bins;
      weight[bin] += w;
      sumX[bin] += Math.cos((h * Math.PI) / 180) * w;
      sumY[bin] += Math.sin((h * Math.PI) / 180) * w;
      total += w;
    }
    // Need a real colour signal, not a few stray saturated pixels.
    if (!opaque || total < opaque * minCoverage) return null;
    let best = 0;
    for (let i = 1; i < bins; i++) if (weight[i] > weight[best]) best = i;
    const hue = ((Math.atan2(sumY[best], sumX[best]) * 180) / Math.PI + 360) % 360;
    // Blues/purples read darker at equal HSL lightness, so lift them a bit.
    const lightness = hue > 200 && hue < 300 ? 0.74 : 0.68;
    return hslToHex(hue, 0.78, lightness);
  } catch {
    return null;
  }
}

/**
 * Logo colour first (a coloured clearlogo like Avengers' gold or a red
 * Spider-Man wordmark is the strongest brand cue, and matching it makes the
 * stack read as one unit), then the backdrop's dominant hue, then gold.
 */
async function resolveAccent(logoBuffer, backdropBuffer) {
  const fromLogo = logoBuffer ? await pickAccentColor(logoBuffer, { minCoverage: 0.15 }) : null;
  if (fromLogo) return fromLogo;
  return (await pickAccentColor(backdropBuffer)) || DEFAULT_ACCENT;
}

/**
 * Tag row under the logo (Sept 30 redesign), right-aligned flush with the
 * logo's visible edge like before. Two optional lines, bottom-up:
 *
 *   meta       "2025 · Series · Drama · Mystery" in a neutral light grey,
 *              medium weight, with the separator dots in the accent colour
 *   highlight  one short label ("Trending Now", "New Series", "Highly
 *              Rated"...) in the accent colour, semibold, lightly tracked
 *
 * Content comes from lib/tags.js; the accent from pickAccentColor above.
 * Font is Manrope (SIL OFL, bundled as static Regular/Medium/SemiBold
 * instances in assets/fonts/ and picked up by fontconfig from the same dir
 * as DejaVu, see lib/fonts.js). Replaces Oswald, whose condensed sporty
 * look read as cheap against the clearlogos. DejaVu stays as the fallback.
 * Both lines share the logo's opacity so the stack dims as one unit.
 */
function buildTagsSvg({
  width, height, marginX, baseMarginY, highlight = null, meta = [],
  metaFontSize, highlightFontSize, lineGap, textOpacity, accent = DEFAULT_ACCENT,
  fontFamily = 'Manrope',
} = {}) {
  const rightX = width - marginX;
  const elements = [];
  let y = height - baseMarginY;
  const family = `${fontFamily}, DejaVu Sans, Arial, sans-serif`;

  if (meta.length) {
    const sep = `<tspan fill="${accent}" fill-opacity="0.85">  ·  </tspan>`;
    const body = meta.map((m) => escapeSvgText(m)).join(sep);
    elements.push(
      `<text x="${rightX}" y="${y}" text-anchor="end" font-family="${family}" ` +
      `font-size="${metaFontSize}" font-weight="500" letter-spacing="0.4" fill="#dcdcdc" fill-opacity="${textOpacity}" xml:space="preserve">` +
      `${body}</text>`
    );
    y -= metaFontSize + Math.round(lineGap * 0.7);
  }

  if (highlight) {
    elements.push(
      `<text x="${rightX}" y="${y}" text-anchor="end" font-family="${family}" ` +
      `font-size="${highlightFontSize}" font-weight="600" letter-spacing="1.1" fill="${accent}" fill-opacity="${Math.min(1, textOpacity + 0.14)}">` +
      `${escapeSvgText(highlight)}</text>`
    );
  }

  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${elements.join('')}</svg>`);
}

// 4x4 Bayer ordered-dither matrix (values 0-15). Used instead of random
// noise for the anti-banding pass below — see the long comment on
// `ditherOverlayAlpha` for why a random-noise grain layer was tried and
// abandoned in an earlier session, and why this is a structurally different
// approach rather than a retry of the same idea.
const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

/**
 * Anti-banding pass (Sept 23): perturbs the darkening overlay's own ALPHA
 * channel with a small ordered (Bayer) dither pattern before it's composited
 * over the backdrop, to break up the 8-bit banding that shows up as visible
 * steps in JPEG's smooth near-black gradient.
 *
 * This is a different mechanism from the grain layer a prior session tried
 * and rejected (see the composeBackground doc comment below for that
 * history):
 *
 * 1. Random noise vs ordered dither. A 4x4 Bayer pattern is periodic — a
 *    small number of repeating spatial frequencies — rather than
 *    full-spectrum random noise, which gives JPEG's 8x8 DCT blocks far
 *    fewer distinct non-zero coefficients to encode for the same visible
 *    effect. Measured directly against literal per-pixel random noise at
 *    the same amplitude on this file's own test backdrop: the Bayer version
 *    cost +50% output bytes, plain random noise cost +191% for the same
 *    nominal amplitude. So this is a real, measured improvement over random
 *    grain, not just a theoretical one.
 * 2. Alpha-channel, spatially self-limiting. The overlay's own fill color is
 *    pure black — blending noise into an all-(0,0,0) layer via a color
 *    blend mode (multiply/overlay/etc.) is a no-op regardless of amplitude,
 *    which is the likely reason the earlier attempt read as "did nothing
 *    detectable" at low settings. Perturbing alpha instead directly changes
 *    how much backdrop shows through at each pixel, which does change the
 *    final composited RGB, and it's naturally confined to the actual
 *    gradient falloff band: pixels where alpha is already 0 (no darkening)
 *    or at its ceiling (fully opaque, nothing left to band) are skipped.
 *
 * Honest limitation, found by measuring rather than assumed: the earlier
 * session's "either invisible or 2-4x bytes" finding turns out to be a real
 * property of running dither through JPEG's own quantization, not something
 * this technique fully escapes — at very low amplitude (~2-3) mozjpeg's
 * psychovisual quantization tables quietly round the perturbation away
 * (near-zero byte change, but also no measurable increase in output gray
 * levels — i.e. genuinely no effect, tested against a synthetic flat-color
 * backdrop). By the amplitude where it survives quantization, the byte cost
 * is scene-dependent: negligible-to-slightly-smaller on a smooth dark
 * gradient (the closest synthetic proxy available here to an actual moody
 * movie backdrop), but a real +44-66% on this file's own busier, multi-
 * gradient test image. This project's sandbox has no live TMDB access (see
 * claude/overview.md), so this could not be measured against a real dark
 * poster before shipping — worth a live before/after size check (the
 * `X-Nuvio-BG-Timing` header's neighboring response size, or just comparing
 * a few `curl`'d file sizes with DITHER=true vs false) alongside the usual
 * visual spot-check, and `DITHER=false` is there to roll it back if it
 * doesn't hold up on real content.
 *
 * `amplitude` is in the same 0-255 alpha units as the channel itself.
 */
async function ditherOverlayAlpha(overlayBuffer, { amplitude = 6 } = {}) {
  const { data, info } = await sharp(overlayBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (channels < 4) return overlayBuffer; // no alpha channel — nothing to dither

  for (let y = 0; y < height; y++) {
    const bayerRow = (y % 4) * 4;
    const rowStart = y * width * channels;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x * channels;
      const a = data[idx + 3];
      if (a <= 0 || a >= 255) continue; // fully clear or fully opaque: nothing to band
      const bayerVal = BAYER_4X4[bayerRow + (x % 4)];
      const offset = Math.round((bayerVal / 15) * (2 * amplitude) - amplitude);
      data[idx + 3] = Math.max(0, Math.min(255, a + offset));
    }
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * Composites: backdrop (cropped to fill, lightly blurred) -> darkening
 * overlay (adaptive to the backdrop's own brightness, dithered — see
 * `ditherOverlayAlpha` above) -> title logo (bottom-right, off-centre so it
 * never collides with Nuvio's own profile list which sits top/mid-left on
 * the TV screen).
 *
 * A note on the dark-scene "pixelation" complaint specifically: a prior
 * session tried an SVG grain/dither layer here and abandoned it — measured
 * against a pristine baseline it either did nothing detectable at an
 * output-size-neutral opacity, or needed 2-4x the output bytes to move the
 * needle at all. That session's conclusion was that the actual cause of
 * both the blockiness and a separate "just plain blurry" complaint was
 * upstream (see BACKDROP_SIZE in api/background.js: requesting TMDB's
 * w1280 backdrop upscaled every image ~1.5x before blur even ran), and
 * fixing that (BACKDROP_SIZE=original, blurSigma 0.6, a sharpen pass) is
 * still correct and unchanged here — reverting BACKDROP_SIZE to a smaller
 * TMDB size to save a download would undo that fix and reintroduce upscale
 * softness, so it was deliberately left alone in this pass (see
 * api/background.js's BACKDROP_SIZE comment).
 *
 * Sept 23 addendum: raw banding in the darkened gradient itself (distinct
 * from the softness/upscale issue above) is a separate, real artifact, most
 * visible on true-black OLED panels. `ditherOverlayAlpha` above targets it
 * with a structurally different technique (ordered dither on alpha, not
 * random color-blended noise) than what was tried before — see its doc
 * comment for why that should avoid the earlier bad cost/benefit tradeoff.
 * Gated by `dither` below for the same easy-rollback reason as `sharpen`.
 *
 * @param {Buffer} backdropBuffer - raw backdrop image bytes (jpg/png)
 * @param {Buffer|null} logoBuffer - raw transparent logo bytes (png), optional
 * @param {object} opts
 */
async function composeBackground(backdropBuffer, logoBuffer, opts = {}) {
  const width = opts.width || WIDTH;
  const height = opts.height || HEIGHT;
  const baseOverlayStrength = opts.overlayStrength ?? 0.72;
  // Logo footprint. Originally 0.24/0.16, cut ~30% on Sept 14 (0.168/0.112),
  // cut again here (Sept 23, Charles: "logo should remain understated, I
  // don't want too much attention drawn to it") to ~0.145/0.097 — roughly
  // another 14% down. Since the tag row's own opacity is tied to
  // `logoOpacity` below (not sized off these fractions), this change is
  // purely about the logo's footprint, not the tag text's size.
  const logoMaxWidthFrac = opts.logoMaxWidthFrac ?? 0.145; // logo width as fraction of canvas
  const logoMaxHeightFrac = opts.logoMaxHeightFrac ?? 0.097; // logo height as fraction of canvas
  // Clearlogos are typically pure-white/full-alpha PNGs, which read as
  // brighter than any of Nuvio's own UI text once stamped on a darkened
  // backdrop. Dimming the logo's own alpha (not just relying on the overlay)
  // lets it still stand out from the backdrop while staying visibly less
  // bright than Nuvio's own on-screen elements (e.g. "Supporter+"). Dropped
  // 0.78 -> 0.68 on Sept 23 alongside the size cut above, same "understated"
  // ask — the tag row dims by the same amount since its own opacity is tied
  // to this value (see buildTagsSvg's call site below).
  const logoOpacity = opts.logoOpacity ?? 0.68;
  const marginFrac = opts.marginFrac ?? 0.045; // margin from right/bottom edges
  // Very light blur only, to settle flat-gradient JPEG quantization in dark
  // scenes; anything much above this measurably softens the whole frame (see
  // BLUR_SIGMA in api/background.js). Readability under the text/profile row
  // comes mainly from the darkening overlay above, not from blurring detail.
  const blurSigma = opts.blurSigma ?? 0.6;
  const jpegQuality = opts.jpegQuality ?? 88;
  // Counters the softness a cover-fit resize/JPEG re-encode naturally
  // introduces, so a downsampled "original"-size source still reads crisp.
  const sharpen = opts.sharpen ?? true;
  // Ordered-dither anti-banding pass on the overlay's alpha channel — see
  // ditherOverlayAlpha's doc comment above. On by default, same rollback
  // pattern as `sharpen`/`SHOW_TAGS`/`SHOW_LOGO`.
  const dither = opts.dither ?? true;
  const ditherAmplitude = opts.ditherAmplitude ?? 6;

  // Tag row under the logo. Callers pass `tags: {highlight, meta}` (built by
  // lib/tags.js). The older genreNames/trendRank options still work so
  // existing callers/tests keep rendering: genres become the meta line and
  // any trend rank becomes a plain "Trending Now" (no number).
  let highlight = null;
  let meta = [];
  if (opts.tags) {
    highlight = opts.tags.highlight || null;
    meta = Array.isArray(opts.tags.meta) ? opts.tags.meta.filter(Boolean).slice(0, 4) : [];
  } else {
    meta = Array.isArray(opts.genreNames) ? opts.genreNames.filter(Boolean).slice(0, 3) : [];
    highlight = opts.trendRank ? 'Trending Now' : null;
  }
  const showTags = meta.length > 0 || !!highlight;
  const metaFontSize = opts.tagsFontSize ?? Math.round(height * 0.0165);
  const highlightFontSize = opts.trendFontSize ?? Math.round(height * 0.0148);
  const tagsLineGap = opts.tagsLineGap ?? Math.round(height * 0.014);
  const tagFont = opts.tagFont || 'Manrope';

  const [uiZoneBrightness, resizedBackdrop, accent] = await Promise.all([
    measureUiZoneBrightness(backdropBuffer, { width, height }),
    (async () => {
      let pipeline = sharp(backdropBuffer).resize(width, height, { fit: 'cover', position: 'attention' });
      if (sharpen) pipeline = pipeline.sharpen();
      if (blurSigma > 0) pipeline = pipeline.blur(blurSigma);
      return pipeline.toBuffer();
    })(),
    showTags ? (opts.accent ? Promise.resolve(opts.accent) : resolveAccent(logoBuffer, backdropBuffer)) : Promise.resolve(null),
  ]);

  const overlayStrength = resolveOverlayStrength(baseOverlayStrength, uiZoneBrightness);
  let overlay = buildOverlaySvg({ width, height, strength: overlayStrength });
  if (dither) {
    overlay = await ditherOverlayAlpha(overlay, { amplitude: ditherAmplitude });
  }

  const composites = [{ input: overlay, top: 0, left: 0 }];

  const marginX = Math.round(width * marginFrac);
  const baseMarginY = Math.round(height * marginFrac * 1.4);

  // Tags render below the logo, so the whole [logo, tags] stack has to sit
  // with its bottom at the same margin the logo alone used to sit at —
  // meaning the logo itself moves up by the tag block's height when tags are
  // present, rather than the tags encroaching on the existing bottom margin.
  let tagsBlockHeight = 0;
  if (showTags) {
    if (meta.length) tagsBlockHeight += metaFontSize;
    if (highlight) tagsBlockHeight += highlightFontSize + (meta.length ? Math.round(tagsLineGap * 0.7) : 0);
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
        width, height, marginX, baseMarginY, highlight, meta,
        metaFontSize, highlightFontSize, lineGap: tagsLineGap, accent, fontFamily: tagFont,
        // Same opacity as the clearlogo, not an independent value — see the
        // buildTagsSvg doc comment above.
        textOpacity: logoOpacity,
      }),
      top: 0,
      left: 0,
    });
  }

  return sharp(resizedBackdrop)
    .composite(composites)
    .jpeg({
      quality: jpegQuality,
      mozjpeg: true,
      // Sept 30 dark-area fix, measured on real TMDB backdrops against a
      // q100 reference: 4:4:4 removes the 16x16 colour blotches 4:2:0 left
      // in near-black regions, and mozjpeg's flat quantisation table (1)
      // keeps ~25-40% more shadow fidelity than its default psychovisual
      // table, which throws dark-area detail away first. Cost: ~170-350KB
      // per image instead of ~90-280KB, fine now that renders are served
      // from a CDN rather than encoded per request.
      chromaSubsampling: opts.chroma || '4:4:4',
      quantisationTable: opts.quantisationTable ?? 1,
    })
    .toBuffer();
}

module.exports = {
  composeBackground,
  buildOverlaySvg,
  buildTagsSvg,
  pickAccentColor,
  resolveAccent,
  measureUiZoneBrightness,
  resolveOverlayStrength,
  ditherOverlayAlpha,
  WIDTH,
  HEIGHT,
};
