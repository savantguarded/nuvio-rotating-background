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

/**
 * Pulls a pool of {id, mediaType, title, backdropPath} from TMDB.
 * pool: 'trending' | 'now_playing' | 'airing_today' | 'popular'
 */
async function fetchPool(pool = 'trending') {
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
        tmdbGet('/discover/movie', 'with_origin_country=US&sort_by=popularity.desc&vote_count.gte=100&page=1'),
        tmdbGet('/discover/movie', 'with_origin_country=US&sort_by=popularity.desc&vote_count.gte=100&page=2'),
        tmdbGet('/discover/tv', 'with_origin_country=US&sort_by=popularity.desc&vote_count.gte=50&page=1'),
        tmdbGet('/discover/tv', 'with_origin_country=US&sort_by=popularity.desc&vote_count.gte=50&page=2'),
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

/**
 * Best available transparent logo for a title, preferring English/no-language
 * PNG/SVG wordmarks (the same assets TMDB serves to Netflix-style clients).
 */
async function fetchLogo(mediaType, id) {
  const data = await tmdbGet(`/${mediaType}/${id}/images`, 'include_image_language=en,null');
  const logos = (data.logos || [])
    .filter((l) => l.file_path.endsWith('.png') || l.file_path.endsWith('.svg'))
    .sort((a, b) => {
      // Prefer English, then highest vote average, then widest.
      const langScore = (l) => (l.iso_639_1 === 'en' ? 2 : l.iso_639_1 === null ? 1 : 0);
      return langScore(b) - langScore(a) || b.vote_average - a.vote_average || b.width - a.width;
    });
  if (!logos.length) return null;
  // PNG only for now (sharp needs librsvg for .svg; keep the fast path simple).
  const png = logos.find((l) => l.file_path.endsWith('.png')) || null;
  if (!png) return null;
  return `${IMG_BASE}/w500${png.file_path}`;
}

module.exports = { fetchPool, backdropUrl, fetchLogo };
