const fs = require('fs');
const path = require('path');

process.env.TMDB_API_KEY = 'fake_key_for_test';

const fakeBackdrop = fs.readFileSync(path.join(__dirname, 'fake-backdrop.jpg'));
const fakeLogo = fs.readFileSync(path.join(__dirname, 'fake-logo.png'));

// 'trending' pool is now built from discover/movie + discover/tv (both
// with_origin_country=US, popularity-sorted, pages 1-2 — the "expand it but
// keep it US-only and most-popular" pool), topped up with trending/week for
// freshness (a trending movie only counts if its id is also in the discover
// set; trending TV is filtered by its own origin_country like before).
// Each mock includes one item that should get filtered out, to prove the
// filters are actually doing something.
const discoverMoviesP1 = {
  results: [
    { id: 2, title: 'Movie Two', backdrop_path: '/two.jpg' },
    { id: 4, title: 'Movie Four', backdrop_path: '/four.jpg' },
  ],
};
const discoverMoviesP2 = {
  results: [
    { id: 6, title: 'Movie Six', backdrop_path: '/six.jpg' },
  ],
};
const discoverTvP1 = {
  results: [
    { id: 1, name: 'Show One', backdrop_path: '/one.jpg' },
  ],
};
const discoverTvP2 = {
  results: [
    { id: 3, name: 'Show Three', backdrop_path: '/three.jpg' },
  ],
};

const trendingMovieResponse = {
  results: [
    { id: 2, title: 'Movie Two', original_language: 'en', backdrop_path: '/two.jpg' }, // in discover -> kept (dedup'd)
    { id: 8, title: 'Movie Not In Discover', original_language: 'en', backdrop_path: '/eight.jpg' }, // not in discover -> filtered
  ],
};

const trendingTvResponse = {
  results: [
    { id: 1, name: 'Show One', origin_country: ['US'], backdrop_path: '/one.jpg' }, // dup, dedup'd
    { id: 3, name: 'Show Three', origin_country: ['US'], backdrop_path: '/three.jpg' }, // dup, dedup'd
    { id: 9, name: 'Show Non-US', origin_country: ['KR'], backdrop_path: '/nine.jpg' }, // filtered
  ],
};

const imagesResponse = {
  logos: [
    { file_path: '/logo.png', iso_639_1: 'en', vote_average: 5, width: 500 },
  ],
};

global.fetch = async (url) => {
  if (url.includes('/discover/movie') && url.includes('page=1')) {
    return { ok: true, json: async () => discoverMoviesP1 };
  }
  if (url.includes('/discover/movie') && url.includes('page=2')) {
    return { ok: true, json: async () => discoverMoviesP2 };
  }
  if (url.includes('/discover/tv') && url.includes('page=1')) {
    return { ok: true, json: async () => discoverTvP1 };
  }
  if (url.includes('/discover/tv') && url.includes('page=2')) {
    return { ok: true, json: async () => discoverTvP2 };
  }
  if (url.includes('/trending/movie/week')) {
    return { ok: true, json: async () => trendingMovieResponse };
  }
  if (url.includes('/trending/tv/week')) {
    return { ok: true, json: async () => trendingTvResponse };
  }
  if (url.includes('/images')) {
    return { ok: true, json: async () => imagesResponse };
  }
  if (url.includes('image.tmdb.org') && url.includes('logo.png')) {
    return { ok: true, arrayBuffer: async () => fakeLogo.buffer.slice(fakeLogo.byteOffset, fakeLogo.byteOffset + fakeLogo.byteLength) };
  }
  if (url.includes('image.tmdb.org')) {
    return { ok: true, arrayBuffer: async () => fakeBackdrop.buffer.slice(fakeBackdrop.byteOffset, fakeBackdrop.byteOffset + fakeBackdrop.byteLength) };
  }
  throw new Error('unexpected fetch: ' + url);
};

const handler = require('../api/background');

function makeRes() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    body: null,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; },
  };
}

async function callOnce(randomValue) {
  const realRandom = Math.random;
  Math.random = () => randomValue;
  try {
    const req = { query: {} };
    const res = makeRes();
    await handler(req, res);
    return res;
  } finally {
    Math.random = realRandom;
  }
}

async function main() {
  // Low random value -> first item; high random value -> last item.
  const resLow = await callOnce(0);
  const resHigh = await callOnce(0.99);

  console.log('low-random status:', resLow.statusCode, 'title:', resLow.headers['X-Nuvio-BG-Title']);
  console.log('high-random status:', resHigh.statusCode, 'title:', resHigh.headers['X-Nuvio-BG-Title']);
  console.log('cache-control:', resLow.headers['Cache-Control']);

  if (resLow.statusCode !== 200 || resHigh.statusCode !== 200) throw new Error('expected 200s');
  if (!Buffer.isBuffer(resLow.body) || resLow.body.length < 1000) throw new Error('expected a real image buffer');
  if (resLow.headers['X-Nuvio-BG-Title'] === resHigh.headers['X-Nuvio-BG-Title']) {
    throw new Error('expected a different title to be picked for a different random value');
  }
  if (resLow.headers['Cache-Control'] !== 'no-store, must-revalidate') {
    throw new Error('expected no-store so every request re-renders (new image on every app open)');
  }
  const filteredTitles = ['Movie Not In Discover', 'Show Non-US'];
  if (filteredTitles.includes(resLow.headers['X-Nuvio-BG-Title']) || filteredTitles.includes(resHigh.headers['X-Nuvio-BG-Title'])) {
    throw new Error('a title that should have been filtered out (non-US, or not in the discover-popular set) was picked');
  }

  // Sept 23: X-Nuvio-BG-Timing lets a live before/after cold-vs-warm check be
  // done from just the response headers (see the doc comment in
  // api/background.js). Just checking it's present and has the expected
  // phases — actual timing values aren't meaningful against fake in-process fetches.
  const timingHeader = resLow.headers['X-Nuvio-BG-Timing'] || '';
  console.log('timing header:', timingHeader);
  for (const phase of ['pool', 'images', 'compose', 'total']) {
    if (!timingHeader.includes(`${phase}=`)) {
      throw new Error(`expected X-Nuvio-BG-Timing to include a "${phase}=" entry, got: ${timingHeader}`);
    }
  }

  fs.writeFileSync(path.join(__dirname, 'handler-output.jpg'), resLow.body);
  console.log('OK — different random values pick different titles, response is never cached, timing header present');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
