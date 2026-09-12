const { composeBackground, WIDTH, HEIGHT } = require('../lib/compose');
const { fetchPool, backdropUrl, fetchLogo } = require('../lib/tmdb');
const sharp = require('sharp');

const POOL = process.env.POOL || 'trending'; // trending | now_playing | airing_today | popular
const SHOW_LOGO = process.env.SHOW_LOGO !== 'false';
const OVERLAY_STRENGTH = Number(process.env.OVERLAY_STRENGTH || 0.72);
const BG_WIDTH = Number(process.env.BG_WIDTH || WIDTH);
const BG_HEIGHT = Number(process.env.BG_HEIGHT || HEIGHT);
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY || 84);
const BLUR_SIGMA = Number(process.env.BLUR_SIGMA ?? 1.4);

// TMDB's documented backdrop sizes are w300 / w780 / w1280 / original — there
// is no "w1920". Requesting an undocumented size risks the CDN silently
// resolving to something smaller than our 1920x1080 canvas, which means
// sharp upscales it to fill the frame — exactly what shows up as soft,
// blocky pixelation in dark scenes. w1280 is a real size, and a modest
// 1.5x upscale is fully masked by the blur/overlay/grain pipeline below, so
// this stays both correct and light (a w1280 JPEG is a fraction of the size
// of "original", which can be full 4K for popular titles).
const BACKDROP_SIZE = process.env.BACKDROP_SIZE || 'w1280';

// A plain dark gradient generated on the fly, used only if TMDB/network fails
// entirely, so Nuvio's background never breaks even if this service hiccups.
async function fallbackImage() {
  const svg = Buffer.from(`
    <svg width="${BG_WIDTH}" height="${BG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0b0b0f" />
          <stop offset="100%" stop-color="#1c1c24" />
        </linearGradient>
      </defs>
      <rect width="${BG_WIDTH}" height="${BG_HEIGHT}" fill="url(#g)" />
    </svg>
  `);
  return sharp(svg).jpeg({ quality: 80 }).toBuffer();
}

// Used only when a title has no usable TMDB logo asset, so the bottom-right
// corner isn't left conspicuously empty. Same position/margins as a real
// logo would get (composeBackground treats it identically).
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

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function pickRandomIndex(length) {
  return Math.floor(Math.random() * length);
}

// Best-effort "don't repeat the last pick back-to-back" — kept in memory on
// the warm Lambda instance. Not durable across cold starts or parallel
// instances, but personal single-user traffic mostly hits a warm instance,
// so this meaningfully cuts down on seeing the same title twice in a row
// out of a ~20-item trending pool.
let lastPickedId = null;

function pickIndexAvoidingRepeat(items) {
  if (items.length <= 1) return 0;
  let index = pickRandomIndex(items.length);
  if (items[index].id === lastPickedId) {
    index = (index + 1) % items.length;
  }
  return index;
}

module.exports = async (req, res) => {
  try {
    const pool = (req.query && req.query.pool) || POOL;

    const items = await fetchPool(pool);
    if (!items.length) throw new Error('TMDB pool returned no usable items');

    const index = pickIndexAvoidingRepeat(items);
    const item = items[index];
    lastPickedId = item.id;

    const [backdropBuffer, logoUrl] = await Promise.all([
      fetchBuffer(backdropUrl(item.backdropPath, BACKDROP_SIZE)),
      SHOW_LOGO ? fetchLogo(item.mediaType, item.id).catch(() => null) : Promise.resolve(null),
    ]);

    let logoBuffer = logoUrl ? await fetchBuffer(logoUrl).catch(() => null) : null;
    if (SHOW_LOGO && !logoBuffer) {
      logoBuffer = await renderTextLogo(item.title).catch(() => null);
    }

    const image = await composeBackground(backdropBuffer, logoBuffer, {
      width: BG_WIDTH,
      height: BG_HEIGHT,
      overlayStrength: OVERLAY_STRENGTH,
      jpegQuality: JPEG_QUALITY,
      blurSigma: BLUR_SIGMA,
    });

    res.setHeader('Content-Type', 'image/jpeg');
    // No caching anywhere in the chain: every real request (i.e. every time
    // Nuvio opens and fetches this URL) picks a new random title and renders
    // a fresh image. Personal single-user traffic, so re-running Sharp per
    // open is cheap; this is what makes "new image on every app open" true
    // rather than "new image every N minutes."
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('X-Nuvio-BG-Title', item.title || '');
    res.status(200).send(image);
  } catch (err) {
    console.error('background generation failed, serving fallback:', err);
    try {
      const fallback = await fallbackImage();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.status(200).send(fallback);
    } catch (err2) {
      res.status(500).send('background generation failed');
    }
  }
};
