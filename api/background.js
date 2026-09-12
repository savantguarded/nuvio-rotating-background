const { composeBackground, WIDTH, HEIGHT } = require('../lib/compose');
const { fetchPool, backdropUrl, fetchLogo } = require('../lib/tmdb');
const sharp = require('sharp');

const POOL = process.env.POOL || 'trending'; // trending | now_playing | airing_today | popular
const SHOW_LOGO = process.env.SHOW_LOGO !== 'false';
const OVERLAY_STRENGTH = Number(process.env.OVERLAY_STRENGTH || 0.55);
const BG_WIDTH = Number(process.env.BG_WIDTH || WIDTH);
const BG_HEIGHT = Number(process.env.BG_HEIGHT || HEIGHT);

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

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function pickRandomIndex(length) {
  return Math.floor(Math.random() * length);
}

module.exports = async (req, res) => {
  try {
    const pool = (req.query && req.query.pool) || POOL;

    const items = await fetchPool(pool);
    if (!items.length) throw new Error('TMDB pool returned no usable items');

    const index = pickRandomIndex(items.length);
    const item = items[index];

    const [backdropBuffer, logoUrl] = await Promise.all([
      fetchBuffer(backdropUrl(item.backdropPath, 'w1920')),
      SHOW_LOGO ? fetchLogo(item.mediaType, item.id).catch(() => null) : Promise.resolve(null),
    ]);

    const logoBuffer = logoUrl ? await fetchBuffer(logoUrl).catch(() => null) : null;

    const image = await composeBackground(backdropBuffer, logoBuffer, {
      width: BG_WIDTH,
      height: BG_HEIGHT,
      overlayStrength: OVERLAY_STRENGTH,
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
