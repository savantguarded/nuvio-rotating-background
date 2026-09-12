const fs = require('fs');
const path = require('path');

process.env.TMDB_API_KEY = 'fake_key_for_test';

const fakeBackdrop = fs.readFileSync(path.join(__dirname, 'fake-backdrop.jpg'));
const fakeLogo = fs.readFileSync(path.join(__dirname, 'fake-logo.png'));

// 'trending' pool is now US-scoped: trending/movie/week filtered to
// original_language 'en', trending/tv/week filtered to origin_country
// including 'US'. Each mock includes one item that should get filtered out,
// to prove the filter is actually doing something.
const trendingMovieResponse = {
  results: [
    { id: 2, title: 'Movie Two', original_language: 'en', backdrop_path: '/two.jpg' },
    { id: 8, title: 'Movie Non-US', original_language: 'fr', backdrop_path: '/eight.jpg' },
  ],
};

const trendingTvResponse = {
  results: [
    { id: 1, name: 'Show One', origin_country: ['US'], backdrop_path: '/one.jpg' },
    { id: 3, name: 'Show Three', origin_country: ['US'], backdrop_path: '/three.jpg' },
    { id: 9, name: 'Show Non-US', origin_country: ['KR'], backdrop_path: '/nine.jpg' },
  ],
};

const imagesResponse = {
  logos: [
    { file_path: '/logo.png', iso_639_1: 'en', vote_average: 5, width: 500 },
  ],
};

global.fetch = async (url) => {
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
  if (resLow.headers['X-Nuvio-BG-Title'] === 'Movie Non-US' || resHigh.headers['X-Nuvio-BG-Title'] === 'Movie Non-US'
    || resLow.headers['X-Nuvio-BG-Title'] === 'Show Non-US' || resHigh.headers['X-Nuvio-BG-Title'] === 'Show Non-US') {
    throw new Error('non-US-filtered title was picked — origin filtering is not working');
  }

  fs.writeFileSync(path.join(__dirname, 'handler-output.jpg'), resLow.body);
  console.log('OK — different random values pick different titles, response is never cached');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
