// Unit test for fetchPool('trending') directly: verifies the discover+trending
// merge actually expands the pool and dedupes overlapping items by
// `mediaType:id`, that the US-only filters still hold, that talk
// show/news/reality/soap TV and TV-movie bloat gets excluded (both via the
// without_genres request param and the client-side genre_ids backstop, since
// trending has no server-side genre filter), and that the pool is cached
// (a second call doesn't re-hit the network).
process.env.TMDB_API_KEY = 'fake_key_for_test';

const discoverMoviesP1 = { results: [
  { id: 1, title: 'M1', backdrop_path: '/m1.jpg' },
  { id: 2, title: 'M2', backdrop_path: '/m2.jpg' },
  { id: 5, title: 'TV Special', backdrop_path: '/m5.jpg', genre_ids: [10770] }, // TV Movie -> bloat, excluded
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
  { id: 21, name: 'Non-US Show', origin_country: ['KR'], backdrop_path: '/t21.jpg' }, // filtered (non-US)
  // Talk show: US, and would otherwise be "fresh" like id 20 above, but
  // trending has no without_genres param — this only gets caught by the
  // client-side genre_ids backstop.
  { id: 30, name: 'Late Night Talk Show', origin_country: ['US'], backdrop_path: '/t30.jpg', genre_ids: [10767] },
] };

let fetchCount = 0;
const seenUrls = [];
global.fetch = async (url) => {
  fetchCount++;
  seenUrls.push(url);
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

  // Expect: movie:1,2,3 (M4 dropped no backdrop, id 5 dropped TV-Movie bloat)
  // + tv:10,11 (discover) + tv:20 (fresh trending, kept) = 6 items.
  // movie:99, tv:21 (non-US), tv:30 (talk show) must be excluded.
  const expected = ['movie:1', 'movie:2', 'movie:3', 'tv:10', 'tv:11', 'tv:20'].sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(ids)}`);
  }

  const discoverMovieUrls = seenUrls.filter((u) => u.includes('/discover/movie'));
  const discoverTvUrls = seenUrls.filter((u) => u.includes('/discover/tv'));
  if (!discoverMovieUrls.every((u) => u.includes('without_genres=10770'))) {
    throw new Error('discover/movie calls should request without_genres=10770 (TV Movie)');
  }
  if (!discoverTvUrls.every((u) => u.includes('without_genres=10763,10764,10766,10767'))) {
    throw new Error('discover/tv calls should request the News/Reality/Soap/Talk without_genres param');
  }

  const countAfterFirstCall = fetchCount;
  const items2 = await fetchPool('trending');
  if (fetchCount !== countAfterFirstCall) {
    throw new Error(`expected the second fetchPool('trending') call to be served from cache (no new fetches), but fetchCount went from ${countAfterFirstCall} to ${fetchCount}`);
  }
  if (items2 !== items) {
    throw new Error('expected the cached call to return the same array reference');
  }

  console.log('OK — pool expanded via discover, deduped, non-US/bloat items excluded, without_genres wired, pool cached');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
