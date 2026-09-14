// Unit test for fetchPool('trending') directly: verifies the discover+trending
// merge actually expands the pool and dedupes overlapping items by
// `mediaType:id`, and that the US-only filters still hold.
process.env.TMDB_API_KEY = 'fake_key_for_test';

const discoverMoviesP1 = { results: [
  { id: 1, title: 'M1', backdrop_path: '/m1.jpg' },
  { id: 2, title: 'M2', backdrop_path: '/m2.jpg' },
] };
const discoverMoviesP2 = { results: [
  { id: 3, title: 'M3', backdrop_path: '/m3.jpg' },
  { id: 4, title: 'M4', backdrop_path: null }, // no backdrop -> dropped
] };
const discoverTvP1 = { results: [
  { id: 10, name: 'T1', backdrop_path: '/t1.jpg' },
] };
const discoverTvP2 = { results: [
  { id: 11, name: 'T2', backdrop_path: '/t2.jpg' },
] };
const trendingMovies = { results: [
  { id: 2, title: 'M2', backdrop_path: '/m2.jpg' }, // dup of discover -> deduped away
  { id: 99, title: 'Not In Discover', backdrop_path: '/x.jpg' }, // not in discover set -> filtered
] };
const trendingTv = { results: [
  { id: 10, name: 'T1', origin_country: ['US'], backdrop_path: '/t1.jpg' }, // dup -> deduped
  { id: 20, name: 'Fresh Trending Show', origin_country: ['US'], backdrop_path: '/t20.jpg' }, // new -> kept
  { id: 21, name: 'Non-US Show', origin_country: ['KR'], backdrop_path: '/t21.jpg' }, // filtered
] };

global.fetch = async (url) => {
  if (url.includes('/discover/movie') && url.includes('page=1')) return { ok: true, json: async () => discoverMoviesP1 };
  if (url.includes('/discover/movie') && url.includes('page=2')) return { ok: true, json: async () => discoverMoviesP2 };
  if (url.includes('/discover/tv') && url.includes('page=1')) return { ok: true, json: async () => discoverTvP1 };
  if (url.includes('/discover/tv') && url.includes('page=2')) return { ok: true, json: async () => discoverTvP2 };
  if (url.includes('/trending/movie/week')) return { ok: true, json: async () => trendingMovies };
  if (url.includes('/trending/tv/week')) return { ok: true, json: async () => trendingTv };
  throw new Error('unexpected fetch: ' + url);
};

const { fetchPool } = require('../lib/tmdb');

async function main() {
  const items = await fetchPool('trending');
  const ids = items.map((i) => `${i.mediaType}:${i.id}`).sort();
  console.log('pool:', ids.join(', '));

  // Expect: movie:1,2,3 (M4 dropped, no backdrop) + tv:10,11 (discover) + tv:20 (fresh trending, kept)
  // = 6 items. movie:99 and tv:21 must be excluded, and movie:2 / tv:10 must not be duplicated.
  const expected = ['movie:1', 'movie:2', 'movie:3', 'tv:10', 'tv:11', 'tv:20'].sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(ids)}`);
  }
  console.log('OK — pool expanded via discover, deduped correctly, non-US/non-discover items excluded');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
