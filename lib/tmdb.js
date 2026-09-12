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
    // Trending alone is one TMDB page (~20 items) and skews toward whatever
    // is currently spiking. Merging in the daily "popular" lists for both
    // movies and TV broadens the rotation with steadier, well-known titles
    // too, so it doesn't feel as narrow or as volatile as trending-only.
    const [trending, movies, tv] = await Promise.all([
      tmdbGet('/trending/all/week'),
      tmdbGet('/movie/popular'),
      tmdbGet('/tv/popular'),
    ]);
    const seen = new Set();
    items = [
      ...trending.results,
      ...movies.results.map((m) => ({ ...m, media_type: 'movie' })),
      ...tv.results.map((t) => ({ ...t, media_type: 'tv' })),
    ].filter((it) => {
      const key = `${it.media_type}:${it.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
