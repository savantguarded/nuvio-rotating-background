// Tag-row content for the line(s) under the logo (Sept 30 redesign).
//
// Two lines, both optional:
//   highlight: one short, accent-coloured label chosen per title from the
//              data TMDB's list endpoints already return (release date,
//              trend position, rating). No numbers, per Charles's ask, and
//              it varies title to title instead of always reading
//              "No. X Trending Today".
//   meta:      year · (Series) · up to two genres, in a neutral colour.
//
// Zero extra TMDB calls: everything here comes from fields already on the
// discover/trending results (see fetchPoolFresh in lib/tmdb.js).

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

/**
 * Picks the one label that best describes why this title is on screen.
 * Order matters: the first rule that matches wins.
 */
function pickHighlight(item, now = Date.now()) {
  const released = parseDate(item.releaseDate);
  const ageDays = released != null ? (now - released) / DAY_MS : null;
  const rank = item.trendRank && item.trendRank.rank;
  const rating = Number(item.voteAverage) || 0;
  const votes = Number(item.voteCount) || 0;
  const ageYears = ageDays != null ? ageDays / 365 : null;

  if (ageDays != null && ageDays < 0) return 'Coming Soon';
  if (item.mediaType === 'tv' && ageDays != null && ageDays <= 60) return 'New Series';
  if (item.mediaType === 'movie' && ageDays != null && ageDays <= 45) return 'New Release';
  if (rank && rank <= 10) return 'Trending Now';
  if (ageYears != null && ageYears >= 25 && rating >= 7.5) return 'Classic';
  if (ageYears != null && ageYears >= 10 && rating >= 7.6 && votes >= 3000) return 'Modern Classic';
  if (rating >= 8.0 && votes >= 1500) return 'Highly Rated';
  if (rank && rank <= 20) return 'Popular This Week';
  if (rating >= 7.8 && votes >= 800) return 'Fan Favourite';
  return null;
}

function metaParts(item) {
  const parts = [];
  const released = parseDate(item.releaseDate);
  if (released != null) parts.push(String(new Date(released).getUTCFullYear()));
  if (item.mediaType === 'tv') parts.push('Series');
  const genres = [];
  for (const g of item.genreNames || []) {
    const name = SHORT_GENRE[g] || g;
    if (!genres.includes(name)) genres.push(name);
    if (genres.length === 2) break;
  }
  return parts.concat(genres);
}

function buildTagContent(item, now = Date.now()) {
  return { highlight: pickHighlight(item, now), meta: metaParts(item) };
}

module.exports = { buildTagContent, pickHighlight, metaParts };
