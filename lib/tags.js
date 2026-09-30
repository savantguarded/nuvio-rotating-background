// Tag-row content for the line(s) under the logo (Sept 30 redesign).
//
// Two lines, both optional:
//   highlight: one short, accent-coloured label chosen per title from the
//              data TMDB's list endpoints already return (release date,
//              trend position, rating). No numbers, per Charles's ask, and
//              it varies title to title instead of always reading
//              "No. X Trending Today".
//   meta:      year · seasons/runtime · up to two genres, neutral colour.
//
// Inputs: the list-result fields on each pool item (release date, trend
// position, rating) plus, when available, the per-title details fetched
// alongside the images in one call (lib/tmdb.js fetchTitleExtras).

const DAY_MS = 24 * 60 * 60 * 1000;

// TMDB's TV genre names are compound ("Sci-Fi & Fantasy") and read long on a
// single right-aligned line. Shortened for display only.
const SHORT_GENRE = {
  'Sci-Fi & Fantasy': 'Sci-Fi',
  'Action & Adventure': 'Action',
  'War & Politics': 'Political',
  'Science Fiction': 'Sci-Fi',
};

function parseDate(str) {
  if (!str) return null;
  const t = Date.parse(str);
  return Number.isFinite(t) ? t : null;
}

const daysBetween = (a, b) => (a - b) / DAY_MS;

/**
 * TV-only labels from the details call (lib/tmdb.js fetchTitleExtras).
 * Returns null when details are missing, so older callers still work.
 */
function tvLifecycleLabel(details, now) {
  if (!details) return null;
  const aired = (details.seasons || [])
    .map((x) => ({ number: x.number, t: parseDate(x.airDate) }))
    .filter((x) => x.t != null && x.t <= now)
    .sort((a, b) => b.number - a.number);
  const latest = aired[0];
  const next = details.nextEpisode ? { ...details.nextEpisode, t: parseDate(details.nextEpisode.airDate) } : null;
  const last = details.lastEpisode ? { ...details.lastEpisode, t: parseDate(details.lastEpisode.airDate) } : null;
  const ended = details.status === 'Ended' || details.status === 'Canceled';

  if (latest && latest.number > 1 && daysBetween(now, latest.t) <= 45) {
    return ended ? 'Final Season' : 'New Season';
  }
  if (next && next.t != null && next.episode === 1 && next.season > 1 && daysBetween(next.t, now) <= 30 && next.t > now) {
    return 'Returning Soon';
  }
  if (next && next.t != null && last && last.t != null && daysBetween(now, last.t) <= 10) return 'New Episodes';
  if (ended && last && last.t != null && daysBetween(now, last.t) <= 60) return 'Final Season';
  return null;
}

/**
 * Picks the one label that best describes why this title is on screen.
 * Order matters: the first rule that matches wins. Never contains a number.
 */
function pickHighlight(item, now = Date.now(), details = null) {
  const released = parseDate(item.releaseDate);
  const ageDays = released != null ? (now - released) / DAY_MS : null;
  const rank = item.trendRank && item.trendRank.rank;
  const rating = Number(item.voteAverage) || 0;
  const votes = Number(item.voteCount) || 0;
  const ageYears = ageDays != null ? ageDays / 365 : null;

  if (ageDays != null && ageDays < 0) return 'Coming Soon';
  if (item.mediaType === 'tv' && ageDays != null && ageDays <= 60) {
    return details && details.type === 'Miniseries' ? 'New Limited Series' : 'New Series';
  }
  if (item.mediaType === 'tv') {
    const lifecycle = tvLifecycleLabel(details, now);
    if (lifecycle) return lifecycle;
  }
  if (item.mediaType === 'movie' && ageDays != null && ageDays <= 45) return 'New Release';
  if (rank && rank <= 10) return 'Trending Now';
  if (ageYears != null && ageYears >= 25 && rating >= 7.5) return 'Classic';
  if (ageYears != null && ageYears >= 10 && rating >= 7.6 && votes >= 3000) return 'Modern Classic';
  if (rating >= 8.0 && votes >= 1500) return 'Highly Rated';
  if (rank && rank <= 20) return 'Popular This Week';
  if (rating >= 7.8 && votes >= 800) return 'Fan Favourite';
  return null;
}

function formatRuntime(minutes) {
  if (!minutes || minutes < 1) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// year · (3 Seasons | Limited Series | Series | 2h 29m) · up to 2 genres
function metaParts(item, details = null) {
  const parts = [];
  const released = parseDate(item.releaseDate);
  if (released != null) parts.push(String(new Date(released).getUTCFullYear()));
  if (item.mediaType === 'tv') {
    const n = details && details.numberOfSeasons;
    if (details && details.type === 'Miniseries') parts.push('Limited Series');
    else if (n) parts.push(n === 1 ? '1 Season' : `${n} Seasons`);
    else parts.push('Series');
  } else {
    const rt = formatRuntime(details && details.runtime);
    if (rt) parts.push(rt);
  }
  const genres = [];
  for (const g of item.genreNames || []) {
    const name = SHORT_GENRE[g] || g;
    if (!genres.includes(name)) genres.push(name);
    if (genres.length === 2) break;
  }
  return parts.concat(genres);
}

function buildTagContent(item, now = Date.now(), details = null) {
  return { highlight: pickHighlight(item, now, details), meta: metaParts(item, details) };
}

module.exports = { buildTagContent, pickHighlight, metaParts, formatRuntime };
