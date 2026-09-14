const TMDB_API = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

function apiKeyParam() {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error('TMDB_API_KEY env var is not set');
  // Supports both classic v3 api_key and v4 read access tokens transparently:
  // if it looks like a JWT (three dot-separated segments), treat it as a bearer token.
  return key;
}

function authHeaders() {
  const key = process.env.TMDB_API_KEY;
  if (key && key.split('.').length === 3) {
    return { Authorization: `Bearer ${key}` };
  }
  return {};
}

function authQuery() {
  const key = process.env.TMDB_API_KEY;
  if (key && key.split('.').length === 3) return '';
  return `api_key=${encodeURIComponent(key)}`;
}

async function tmdbGet(path, extraParams = '') {
  const qs = [authQuery(), extraParams].filter(Boolean).join('&');
  const url = `${TMDB_API}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`TMDB ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// TV genres that aren't "a show" in the Netflix-picker sense — talk shows,
// news, reality/game shows, soaps. These regularly show up in discover/tv
// and trending/tv despite the US+popularity filters (a long-running talk
// show racks up plenty of both), and their backdrops/logos are usually a
// title card or a stage photo, not the kind of image this is for.
const BLOAT_TV_GENRE_IDS = new Set([10763, 10764, 10766, 10767]); // News, Reality, Soap, Talk
// "TV Movie" on the movie side — made-for-TV specials/reunions/concert
// films that land in discover/movie's popularity charts but aren't a movie
// in the sense this pool means.
const BLOAT_MOVIE_GENRE_IDS = new Set([10770]);
const BLOAT_TV_GENRES_PARAM = [...BLOAT_TV_GENRE_IDS].join(',');
const BLOAT_MOVIE_GENRES_PARAM = [...BLOAT_MOVIE_GENRE_IDS].join(',');

function isBloat(item) {
  if (!Array.isArray(item.genre_ids)) return false;
  const bloatSet = item.media_type === 'tv' ? BLOAT_TV_GENRE_IDS : BLOAT_MOVIE_GENRE_IDS;
  return item.genre_ids.some((g) => bloatSet.has(g));
}

// The pool-building calls below (discover x4 + trending x2 = 6 TMDB round
// trips) are the single biggest chunk of per-request latency, and the pool
// itself doesn't need to be TMDB-fresh on every app open — it changes on the
// order of hours, not seconds. Cached per warm Lambda instance (same
// don't-persist-across-cold-starts caveat as `lastPickedId` in
// api/background.js) for a few minutes, so most requests skip straight to
// "pick + render" instead of re-fetching six lists first.
const POOL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const poolCache = new Map(); // pool name -> { items, fetchedAt }

/**
 * Pulls a pool of {id, mediaType, title, backdropPath} from TMDB.
 * pool: 'trending' | 'now_playing' | 'airing_today' | 'popular'
 */
async function fetchPool(pool = 'trending') {
  const cached = poolCache.get(pool);
  if (cached && Date.now() - cached.fetchedAt < POOL_CACHE_TTL_MS) {
    return cached.items;
  }
  const items = await fetchPoolFresh(pool);
  poolCache.set(pool, { items, fetchedAt: Date.now() });
  return items;
}

async function fetchPoolFresh(pool) {
  let items = [];

  if (pool === 'trending') {
    // US-only, and bigger than the old trending-week-only pool (~20 movies +
    // ~20 TV before filtering). Two layers:
    //
    // 1. Discover, the reliable US signal: `with_origin_country=US` is a real
    //    TMDB data field (production country for movies, origin country for
    //    TV) rather than a proxy, sorted by popularity so pages 1-2 (top 80
    //    per media type) stay "most popular," with a light vote_count floor
    //    so a low-signal title can't sneak in on a transient popularity
    //    spike. This is the bulk of the pool and the part that answers
    //    "expand it, but only the most popular stuff."
    // 2. Trending, for freshness: the weekly trending lists, folded in for
    //    the "currently spiking" titles discover's popularity sort can lag a
    //    few days behind. TV trending items carry `origin_country` directly
    //    so they're filtered the same reliable way; movie trending items
    //    don't carry origin_country at all (only the details endpoint has
    //    it), so instead of the old original_language==='en' proxy (which
    //    let in non-US English-language films — UK, Australian, Irish...),
    //    a trending movie only makes the cut if its id also showed up in the
    //    discover-US-movies set above, which is a precise membership check.
    const [discoverMoviesP1, discoverMoviesP2, discoverTvP1, discoverTvP2, trendingMovies, trendingTv] =
      await Promise.all([
        tmdbGet('/discover/movie', `with_origin_country=US&sort_by=popularity.desc&vote_count.gte=100&without_genres=${BLOAT_MOVIE_GENRES_PARAM}&page=1`),
        tmdbGet('/discover/movie', `with_origin_country=US&sort_by=popularity.desc&vote_count.gte=100&without_genres=${BLOAT_MOVIE_GENRES_PARAM}&page=2`),
        tmdbGet('/discover/tv', `with_origin_country=US&sort_by=popularity.desc&vote_count.gte=50&without_genres=${BLOAT_TV_GENRES_PARAM}&page=1`),
        tmdbGet('/discover/tv', `with_origin_country=US&sort_by=popularity.desc&vote_count.gte=50&without_genres=${BLOAT_TV_GENRES_PARAM}&page=2`),
        tmdbGet('/trending/movie/week'),
        tmdbGet('/trending/tv/week'),
      ]);

    const discoverMovies = [...discoverMoviesP1.results, ...discoverMoviesP2.results]
      .map((m) => ({ ...m, media_type: 'movie' }));
    const discoverTv = [...discoverTvP1.results, ...discoverTvP2.results]
      .map((t) => ({ ...t, media_type: 'tv' }));

    const discoverMovieIds = new Set(discoverMovies.map((m) => m.id));

    items = [
      ...discoverMovies,
      ...discoverTv,
      ...trendingMovies.results
        .filter((m) => discoverMovieIds.has(m.id))
        .map((m) => ({ ...m, media_type: 'movie' })),
      ...trendingTv.results
        .filter((t) => Array.isArray(t.origin_country) && t.origin_country.includes('US'))
        .map((t) => ({ ...t, media_type: 'tv' })),
    ];
  } else if (pool === 'now_playing') {
    const data = await tmdbGet('/movie/now_playing', 'region=US');
    items = data.results.map((m) => ({ ...m, media_type: 'movie' }));
  } else if (pool === 'airing_today') {
    const data = await tmdbGet('/tv/airing_today');
    items = data.results.map((t) => ({ ...t, media_type: 'tv' }));
  } else if (pool === 'popular') {
    const [movies, tv] = await Promise.all([
      tmdbGet('/movie/popular'),
      tmdbGet('/tv/popular'),
    ]);
    items = [
      ...movies.results.map((m) => ({ ...m, media_type: 'movie' })),
      ...tv.results.map((t) => ({ ...t, media_type: 'tv' })),
    ];
  } else {
    throw new Error(`Unknown pool "${pool}"`);
  }

  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    if (!it.backdrop_path || (it.media_type !== 'movie' && it.media_type !== 'tv')) continue;
    // Backstop for every pool, not just the ones with server-side
    // without_genres support: trending (and `popular`/`airing_today`) can't
    // be filtered server-side by genre, so this client-side check on
    // genre_ids (present on all TMDB list results) is what actually keeps
    // talk shows/news/reality/soap and TV-movie specials out of those.
    if (isBloat(it)) continue;
    const key = `${it.media_type}:${it.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }

  return deduped.map((it) => ({
    id: it.id,
    mediaType: it.media_type,
    title: it.title || it.name,
    backdropPath: it.backdrop_path,
  }));
}

function backdropUrl(backdropPath, size = 'original') {
  return `${IMG_BASE}/${size}${backdropPath}`;
}

// A title's logo asset basically never changes. Cached per warm instance so
// a title picked more than once in a session skips the /images round trip
// (the pool cache above means the same handful of titles come up
// repeatedly within a 10-minute window).
const LOGO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const logoCache = new Map(); // `${mediaType}:${id}` -> { url, fetchedAt }

/**
 * Best available transparent logo for a title, preferring English/no-language
 * PNG/SVG wordmarks (the same assets TMDB serves to Netflix-style clients).
 */
async function fetchLogo(mediaType, id) {
  const key = `${mediaType}:${id}`;
  const cached = logoCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < LOGO_CACHE_TTL_MS) {
    return cached.url;
  }

  const data = await tmdbGet(`/${mediaType}/${id}/images`, 'include_image_language=en,null');
  const logos = (data.logos || [])
    .filter((l) => l.file_path.endsWith('.png') || l.file_path.endsWith('.svg'))
    .sort((a, b) => {
      // Prefer English, then highest vote average, then widest.
      const langScore = (l) => (l.iso_639_1 === 'en' ? 2 : l.iso_639_1 === null ? 1 : 0);
      return langScore(b) - langScore(a) || b.vote_average - a.vote_average || b.width - a.width;
    });
  // PNG only for now (sharp needs librsvg for .svg; keep the fast path simple).
  const png = logos.find((l) => l.file_path.endsWith('.png')) || null;
  const url = png ? `${IMG_BASE}/w500${png.file_path}` : null;

  logoCache.set(key, { url, fetchedAt: Date.now() });
  return url;
}

module.exports = { fetchPool, backdropUrl, fetchLogo };
