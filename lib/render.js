// Full render of one pool item: fetch backdrop + logo from TMDB, compose.
// Shared by the pre-render job (scripts/prerender.js, runs in GitHub
// Actions) and the endpoint's live-render fallback (api/background.js).
const sharp = require('sharp');
const { composeBackground, WIDTH, HEIGHT } = require('./compose');
const { backdropUrl, fetchLogo } = require('./tmdb');
const { buildTagContent } = require('./tags');
const { ensureFontsConfigured } = require('./fonts');

// renderTextLogo below rasterizes SVG text, so fonts must be registered
// first (see lib/fonts.js for the Vercel "tofu boxes" history).
ensureFontsConfigured();

function envConfig(env = process.env) {
  return {
    showLogo: env.SHOW_LOGO !== 'false',
    showTags: env.SHOW_TAGS !== 'false',
    // Floor, adaptively boosted on bright backdrops (resolveOverlayStrength).
    overlayStrength: Number(env.OVERLAY_STRENGTH || 0.9),
    width: Number(env.BG_WIDTH || WIDTH),
    height: Number(env.BG_HEIGHT || HEIGHT),
    // Sept 30: 86 -> 88 with 4:4:4 chroma and a flat quant table (see the
    // .jpeg() call in lib/compose.js). The "pixelated dark areas" were 4:2:0
    // chroma blotches plus mozjpeg's default table dropping shadow detail.
    jpegQuality: Number(env.JPEG_QUALITY || 88),
    blurSigma: Number(env.BLUR_SIGMA ?? 0.6),
    sharpen: env.SHARPEN !== 'false',
    dither: env.DITHER !== 'false',
    // See the long BACKDROP_SIZE history in git log / claude/overview.md:
    // "original" avoids upscaling to 1920x1080, which is what made images soft.
    backdropSize: env.BACKDROP_SIZE || 'original',
    tagFont: env.TAG_FONT || 'Manrope',
  };
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fallbackImage({ width = WIDTH, height = HEIGHT } = {}) {
  const svg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0b0b0f" />
          <stop offset="100%" stop-color="#1c1c24" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#g)" />
    </svg>
  `);
  return sharp(svg).jpeg({ quality: 80 }).toBuffer();
}

// Only used when a title has no TMDB clearlogo, so the corner isn't empty.
async function renderTextLogo(title) {
  const safe = String(title || '').slice(0, 40).replace(/[<&>]/g, '');
  const svg = Buffer.from(`
    <svg width="900" height="200" xmlns="http://www.w3.org/2000/svg">
      <text x="0" y="140" font-family="Arial, Helvetica, sans-serif" font-size="88"
            font-weight="800" letter-spacing="2" fill="white">${safe}</text>
    </svg>
  `);
  return sharp(svg).png().toBuffer();
}

/**
 * Renders one pool item. Returns { image, tags, timing }.
 * `now` is injectable so tag labels ("New Series"...) are testable.
 */
async function renderItem(item, cfg = envConfig(), { now = Date.now() } = {}) {
  const timing = {};
  const mark = (label, since) => { timing[label] = Date.now() - since; };

  const tImages = Date.now();
  const backdropPromise = fetchBuffer(backdropUrl(item.backdropPath, cfg.backdropSize));
  const logoPromise = cfg.showLogo
    ? fetchLogo(item.mediaType, item.id)
        .catch(() => null)
        .then((url) => (url ? fetchBuffer(url).catch(() => null) : null))
    : Promise.resolve(null);
  const [backdropBuffer, fetchedLogo] = await Promise.all([backdropPromise, logoPromise]);
  mark('images', tImages);

  let logoBuffer = fetchedLogo;
  if (cfg.showLogo && !logoBuffer) {
    logoBuffer = await renderTextLogo(item.title).catch(() => null);
  }

  const tags = cfg.showTags ? buildTagContent(item, now) : { highlight: null, meta: [] };

  const tCompose = Date.now();
  const image = await composeBackground(backdropBuffer, logoBuffer, {
    width: cfg.width,
    height: cfg.height,
    overlayStrength: cfg.overlayStrength,
    jpegQuality: cfg.jpegQuality,
    blurSigma: cfg.blurSigma,
    sharpen: cfg.sharpen,
    dither: cfg.dither,
    tags,
    tagFont: cfg.tagFont,
  });
  mark('compose', tCompose);

  return { image, tags, timing };
}

module.exports = { renderItem, envConfig, fallbackImage, renderTextLogo, fetchBuffer };
