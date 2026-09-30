// Nuvio profile background endpoint.
//
// Sept 30: serves pre-rendered images instead of rendering per request.
// A GitHub Actions job (.github/workflows/prerender.yml, scripts/prerender.js)
// renders a fresh set of ~30 backgrounds every hour on GitHub's runners and
// publishes them to GitHub Pages with a manifest.json. This function just
// picks one at random and streams it, so an app open costs a tiny manifest
// lookup (cached) plus one image fetch (also cached per warm instance),
// instead of 6 TMDB calls + ~1s of Sharp work on Vercel Hobby's single vCPU.
//
// Why Pages and not Vercel Blob: Blob's Hobby tier includes 2,000 writes a
// month and locks the store for 30 days if exceeded; an hourly 30-image
// refresh is ~21,600 writes. Pages has no per-write quota.
//
// If the pre-rendered set can't be reached for any reason, it falls back to
// the old live render (same output), and past that to a plain dark
// gradient, so Nuvio's background never breaks. `?live=1` forces the live
// path for debugging.
//
// Heavy modules (sharp, compose, tmdb) are only required on the live path,
// so a cold start on the fast path doesn't pay to load native image code.

const PRERENDER_BASE = (process.env.PRERENDER_BASE ||
  'https://savantguarded.github.io/nuvio-rotating-background').replace(/\/+$/, '');
const PRERENDER_ENABLED = process.env.PRERENDER_BASE !== 'off';
const POOL = process.env.POOL || 'trending';

const MANIFEST_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_IMAGES = 40;

let manifestCache = null; // { data, fetchedAt }
const imageCache = new Map(); // `${generatedAt}/${file}` -> Buffer
let lastPicked = null;

async function getManifest() {
  if (manifestCache && Date.now() - manifestCache.fetchedAt < MANIFEST_TTL_MS) {
    return manifestCache.data;
  }
  try {
    const res = await fetch(`${PRERENDER_BASE}/manifest.json?t=${Math.floor(Date.now() / 60000)}`);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.items) || !data.items.length) throw new Error('manifest has no items');
    manifestCache = { data, fetchedAt: Date.now() };
    return data;
  } catch (err) {
    // Serve the last good manifest rather than dropping to a slow live
    // render because of one blip.
    if (manifestCache) return manifestCache.data;
    throw err;
  }
}

// Best-effort "not the same one twice in a row", per warm instance.
function pickAvoidingRepeat(items, key, lastKey) {
  if (items.length <= 1) return items[0];
  let i = Math.floor(Math.random() * items.length);
  if (key(items[i]) === lastKey) i = (i + 1) % items.length;
  return items[i];
}

async function getImage(manifest, entry) {
  const cacheKey = `${manifest.generatedAt}/${entry.file}`;
  const hit = imageCache.get(cacheKey);
  if (hit) return { buf: hit, cached: true };
  const res = await fetch(`${PRERENDER_BASE}/${entry.file}?v=${encodeURIComponent(manifest.generatedAt)}`);
  if (!res.ok) throw new Error(`image ${entry.file} ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (imageCache.size >= MAX_CACHED_IMAGES) imageCache.delete(imageCache.keys().next().value);
  imageCache.set(cacheKey, buf);
  return { buf, cached: false };
}

function sendImage(res, image, headers) {
  res.setHeader('Content-Type', 'image/jpeg');
  // Never cached anywhere, so every app open gets a new random pick.
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(200).send(image);
}

async function servePrerendered(res, t0) {
  const tManifest = Date.now();
  const manifest = await getManifest();
  const manifestMs = Date.now() - tManifest;

  const entry = pickAvoidingRepeat(manifest.items, (e) => e.file, lastPicked);
  lastPicked = entry.file;

  const tImage = Date.now();
  const { buf, cached } = await getImage(manifest, entry);

  sendImage(res, buf, {
    'X-Nuvio-BG-Source': 'prerendered',
    'X-Nuvio-BG-Title': entry.title || '',
    'X-Nuvio-BG-Tags': [entry.highlight, ...(entry.meta || [])].filter(Boolean).join(' | '),
    'X-Nuvio-BG-Generated': manifest.generatedAt || '',
    'X-Nuvio-BG-Timing': `manifest=${manifestMs}ms;image=${Date.now() - tImage}ms${cached ? '(mem)' : ''};total=${Date.now() - t0}ms`,
  });
}

let lastLiveId = null;

async function serveLive(req, res, t0) {
  const { fetchPool } = require('../lib/tmdb');
  const { renderItem, envConfig } = require('../lib/render');

  const tPool = Date.now();
  const pool = (req.query && req.query.pool) || POOL;
  const items = await fetchPool(pool);
  const poolMs = Date.now() - tPool;
  if (!items.length) throw new Error('TMDB pool returned no usable items');

  const item = pickAvoidingRepeat(items, (it) => it.id, lastLiveId);
  lastLiveId = item.id;

  const { image, tags, timing } = await renderItem(item, envConfig());
  sendImage(res, image, {
    'X-Nuvio-BG-Source': 'live',
    'X-Nuvio-BG-Title': item.title || '',
    'X-Nuvio-BG-Genres': (item.genreNames || []).join(', '),
    'X-Nuvio-BG-Tags': [tags.highlight, ...(tags.meta || [])].filter(Boolean).join(' | '),
    'X-Nuvio-BG-Timing': `pool=${poolMs}ms;images=${timing.images}ms;compose=${timing.compose}ms;total=${Date.now() - t0}ms`,
  });
}

module.exports = async (req, res) => {
  const t0 = Date.now();
  const forceLive = req.query && (req.query.live === '1' || req.query.pool);

  if (PRERENDER_ENABLED && !forceLive) {
    try {
      return await servePrerendered(res, t0);
    } catch (err) {
      console.error('pre-rendered set unavailable, rendering live:', err.message);
    }
  }

  try {
    return await serveLive(req, res, t0);
  } catch (err) {
    console.error('background generation failed, serving fallback:', err);
    try {
      const { fallbackImage } = require('../lib/render');
      sendImage(res, await fallbackImage(), { 'X-Nuvio-BG-Source': 'fallback' });
    } catch (err2) {
      res.status(500).send('background generation failed');
    }
  }
};
