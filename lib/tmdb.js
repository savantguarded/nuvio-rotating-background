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
    // Scoped to US content only. TMDB's trending endpoint has no region
    // filter, so this pulls trending movies and TV separately and filters
    // each down to a US signal, to keep the risk of a non-US title (and the
    // missing/mismatched clearlogo that tends to come with it) as low as
    // possible: TV list items carry an `origin_country` array we can check
    // directly; movie list items don't carry origin_country (that's only on
    // the movie details endpoint), so original language is used as the
    // closest available proxy — practically every English-language title
    // has a proper English TMDB clearlogo.
    const [movies, tv] = await Promise.all([
      tmdbGet('/trending/movie/week'),
      tmdbGet('/trending/tv/week'),
    ]);
    items = [
      ...movies.results
        .filter((m) => m.original_language === 'en')
        .map((m) => ({ ...m, media_type: 'movie' })),
      ...tv.results
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

  return items
    .filter((it) => it.backdrop_path && (it.media_type === 'movie' || it.media_type === 'tv'))
    .map((it) => ({
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
