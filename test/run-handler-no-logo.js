// Verifies the text-logo fallback: a title with no TMDB logo asset should
// still render successfully with a stamped text wordmark, not an empty
// corner or a crash.
const fs = require('fs');
const path = require('path');

process.env.TMDB_API_KEY = 'fake_key_for_test';

const fakeBackdrop = fs.readFileSync(path.join(__dirname, 'fake-backdrop.jpg'));

const trendingResponse = {
  results: [
    { id: 1, name: 'A Title With No Logo Asset', media_type: 'tv', backdrop_path: '/one.jpg' },
  ],
};

global.fetch = async (url) => {
  if (url.includes('/trending/all/week')) {
    return { ok: true, json: async () => trendingResponse };
  }
  if (url.includes('/images')) {
    return { ok: true, json: async () => ({ logos: [] }) }; // no logos at all
  }
  if (url.includes('image.tmdb.org')) {
    return { ok: true, arrayBuffer: async () => fakeBackdrop.buffer.slice(fakeBackdrop.byteOffset, fakeBackdrop.byteOffset + fakeBackdrop.byteLength) };
  }
  throw new Error('unexpected fetch: ' + url);
};

const handler = require('../api/background');

function makeRes() {
  const headers = {};
  return { headers, statusCode: null, body: null, setHeader(k, v) { headers[k] = v; }, status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; } };
}

(async () => {
  const res = makeRes();
  await handler({ query: {} }, res);
  console.log('status:', res.statusCode, 'bytes:', res.body && res.body.length, 'title:', res.headers['X-Nuvio-BG-Title']);
  if (res.statusCode !== 200 || !Buffer.isBuffer(res.body) || res.body.length < 1000) {
    throw new Error('expected a real rendered image even with no logo asset available');
  }
  fs.writeFileSync(path.join(__dirname, 'no-logo-output.jpg'), res.body);
  console.log('OK — text-logo fallback rendered successfully with no TMDB logo asset');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
