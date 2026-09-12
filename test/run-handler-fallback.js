process.env.TMDB_API_KEY = 'fake_key_for_test';
global.fetch = async () => { throw new Error('simulated network outage'); };

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

(async () => {
  const res = makeRes();
  await handler({ query: {} }, res);
  console.log('status:', res.statusCode, 'content-type:', res.headers['Content-Type'], 'bytes:', res.body && res.body.length);
  if (res.statusCode !== 200 || !Buffer.isBuffer(res.body)) throw new Error('fallback path broken');
  console.log('OK — fallback served a valid image on total TMDB outage');
})();
