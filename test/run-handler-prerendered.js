// Fast path: api/background.js serves from the pre-rendered manifest, picks
// different entries for different random values, caches image bytes per
// warm instance, and drops to the live render when the set is unreachable.
const fs = require('fs');
const path = require('path');

const fakeImage = fs.readFileSync(path.join(__dirname, 'fake-backdrop.jpg'));
const manifest = {
  generatedAt: '2026-09-30T12:17:00.000Z',
  count: 3,
  items: [
    { file: 'bg/00.jpg', title: 'First', highlight: 'Trending Now', meta: ['2026', 'Action'] },
    { file: 'bg/01.jpg', title: 'Second', highlight: null, meta: ['2019', 'Series', 'Drama'] },
    { file: 'bg/02.jpg', title: 'Third', highlight: 'Classic', meta: ['1994', 'Drama'] },
  ],
};

let manifestUp = true;
const fetched = [];
global.fetch = async (url) => {
  fetched.push(url);
  if (url.includes('/manifest.json')) {
    if (!manifestUp) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => manifest };
  }
  if (url.includes('.github.io/') && url.includes('/bg/')) {
    return { ok: true, arrayBuffer: async () => fakeImage.buffer.slice(fakeImage.byteOffset, fakeImage.byteOffset + fakeImage.byteLength) };
  }
  throw new Error('unexpected fetch: ' + url);
};

const handler = require('../api/background');

function makeRes() {
  const headers = {};
  return {
    headers, statusCode: null, body: null,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; },
  };
}

async function call(random, query = {}) {
  const real = Math.random;
  Math.random = () => random;
  try {
    const res = makeRes();
    await handler({ query }, res);
    return res;
  } finally {
    Math.random = real;
  }
}

async function main() {
  const a = await call(0);
  const b = await call(0.99);
  console.log('a:', a.headers['X-Nuvio-BG-Title'], a.headers['X-Nuvio-BG-Timing']);
  console.log('b:', b.headers['X-Nuvio-BG-Title'], b.headers['X-Nuvio-BG-Timing']);
  if (a.statusCode !== 200 || a.headers['X-Nuvio-BG-Source'] !== 'prerendered') throw new Error('expected prerendered 200');
  if (!Buffer.isBuffer(a.body) || !a.body.equals(fakeImage)) throw new Error('expected the published bytes, unmodified');
  if (a.headers['X-Nuvio-BG-Title'] === b.headers['X-Nuvio-BG-Title']) throw new Error('expected different picks');
  if (a.headers['Cache-Control'] !== 'no-store, must-revalidate') throw new Error('response must not be cached');
  if (a.headers['X-Nuvio-BG-Tags'] !== 'Trending Now | 2026 | Action') throw new Error('tags header wrong: ' + a.headers['X-Nuvio-BG-Tags']);

  // The whole set gets preloaded after the first manifest load.
  await new Promise((r) => setTimeout(r, 50));
  const imageFetches = new Set(fetched.filter((u) => u.includes('/bg/')).map((u) => u.split('?')[0]));
  if (imageFetches.size !== manifest.items.length) throw new Error(`expected all ${manifest.items.length} images preloaded, got ${imageFetches.size}`);

  // ?redirect=1 test switch: 302 to the CDN copy, still never cached.
  const r = await call(0.5, { redirect: '1' });
  if (r.statusCode !== 302 || !/\.github\.io\/.*\/bg\/\d+\.jpg\?v=/.test(r.headers.Location || '')) throw new Error('bad redirect: ' + r.statusCode + ' ' + r.headers.Location);
  if (r.headers['Cache-Control'] !== 'no-store, must-revalidate') throw new Error('redirect must not be cacheable');

  // Third was just served, so 0.99 would repeat it and steps to First,
  // which was already fetched once: its bytes must now come from memory.
  const before = fetched.length;
  await call(0.99); // resets lastPicked after the redirect call
  const c = await call(0.99);
  if (c.headers['X-Nuvio-BG-Title'] !== 'First') throw new Error('expected repeat-avoidance to step to First');
  if (!/\(mem\)/.test(c.headers['X-Nuvio-BG-Timing'])) throw new Error('expected an in-memory image hit');
  const manifestRefetches = fetched.slice(before).filter((u) => u.includes('manifest')).length;
  if (manifestRefetches) throw new Error('manifest should be cached between requests');

  // Never repeats back-to-back.
  const d = await call(0);
  if (d.headers['X-Nuvio-BG-Title'] === c.headers['X-Nuvio-BG-Title']) throw new Error('picked the same image twice in a row');

  // Set unreachable on a cold instance -> live render path is attempted
  // (TMDB isn't mocked here, so it ends in the gradient fallback: still 200).
  delete require.cache[require.resolve('../api/background')];
  manifestUp = false;
  process.env.TMDB_API_KEY = 'fake';
  const cold = require('../api/background');
  const res = makeRes();
  await cold({ query: {} }, res);
  if (res.statusCode !== 200 || res.headers['X-Nuvio-BG-Source'] !== 'fallback') throw new Error('expected graceful fallback, got ' + res.headers['X-Nuvio-BG-Source']);

  console.log('OK — serves pre-rendered set, varies picks, caches manifest + bytes, avoids repeats');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
