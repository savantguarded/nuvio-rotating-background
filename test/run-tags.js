// Tag-row content rules (lib/tags.js): labels vary by title, never carry a
// number, and the meta line is year · (Series) · up to two short genres.
const { buildTagContent } = require('../lib/tags');

const NOW = Date.parse('2026-09-30T12:00:00Z');
const cases = [
  [{ mediaType: 'tv', releaseDate: '2026-08-20', genreNames: ['Drama', 'Sci-Fi & Fantasy', 'Mystery'] },
    'New Series', ['2026', 'Series', 'Drama', 'Sci-Fi']],
  [{ mediaType: 'movie', releaseDate: '2026-09-10', genreNames: ['Horror'] }, 'New Release', ['2026', 'Horror']],
  [{ mediaType: 'movie', releaseDate: '2026-12-18', genreNames: ['Action'] }, 'Coming Soon', ['2026', 'Action']],
  [{ mediaType: 'movie', releaseDate: '2026-06-01', trendRank: { rank: 3 }, genreNames: ['Action'] }, 'Trending Now', ['2026', 'Action']],
  [{ mediaType: 'movie', releaseDate: '1994-09-23', voteAverage: 8.7, voteCount: 28000, genreNames: ['Drama', 'Crime'] }, 'Classic', ['1994', 'Drama', 'Crime']],
  [{ mediaType: 'tv', releaseDate: '2008-01-20', voteAverage: 8.9, voteCount: 15000, genreNames: ['Drama', 'Crime'] }, 'Modern Classic', ['2008', 'Series', 'Drama', 'Crime']],
  [{ mediaType: 'movie', releaseDate: '2024-02-27', voteAverage: 8.1, voteCount: 7000, genreNames: ['Science Fiction', 'Adventure'] }, 'Highly Rated', ['2024', 'Sci-Fi', 'Adventure']],
  [{ mediaType: 'tv', releaseDate: '2023-07-23', trendRank: { rank: 14 }, voteAverage: 7.0, voteCount: 400, genreNames: ['Drama'] }, 'Popular This Week', ['2023', 'Series', 'Drama']],
  [{ mediaType: 'movie', releaseDate: '2021-05-05', voteAverage: 6.1, voteCount: 900, genreNames: [] }, null, ['2021']],
  [{ mediaType: 'movie', releaseDate: '2021-05-05', voteAverage: 6.1, voteCount: 900, genreNames: ['Horror', 'Mystery'] }, 'Spine-Chilling', ['2021', 'Horror', 'Mystery']],
  [{ mediaType: 'movie', releaseDate: '2025-06-01', voteAverage: 7.0, voteCount: 2400, genreNames: ['Animation'] }, 'Popular Now', ['2025', 'Animation']],
  [{ mediaType: 'tv', releaseDate: '2025-06-01', voteAverage: 7.0, voteCount: 120, genreNames: ['Sci-Fi & Fantasy'] }, 'Mind-Bending', ['2025', 'Series', 'Sci-Fi']],
];

// With per-title details (lib/tmdb.js fetchTitleExtras).
const S = (n, d) => ({ number: n, airDate: d });
const detailCases = [
  [{ mediaType: 'tv', releaseDate: '2019-01-01', genreNames: ['Drama'] },
    { status: 'Returning Series', numberOfSeasons: 3, seasons: [S(1, '2019-01-01'), S(2, '2022-01-01'), S(3, '2026-09-12')],
      lastEpisode: { airDate: '2026-09-26', season: 3 }, nextEpisode: { airDate: '2026-10-03', season: 3, episode: 4 } },
    'New Season', ['2019', '3 Seasons', 'Drama']],
  [{ mediaType: 'tv', releaseDate: '2019-01-01', genreNames: ['Drama'] },
    { status: 'Ended', numberOfSeasons: 4, seasons: [S(1, '2019-01-01'), S(4, '2026-09-01')], lastEpisode: { airDate: '2026-09-29', season: 4 }, nextEpisode: null },
    'Final Season', ['2019', '4 Seasons', 'Drama']],
  [{ mediaType: 'tv', releaseDate: '2019-01-01', genreNames: ['Comedy'] },
    { status: 'Returning Series', numberOfSeasons: 2, seasons: [S(1, '2019-01-01'), S(2, '2021-01-01')], lastEpisode: { airDate: '2021-03-01', season: 2 },
      nextEpisode: { airDate: '2026-10-20', season: 3, episode: 1 } },
    'Returning Soon', ['2019', '2 Seasons', 'Comedy']],
  [{ mediaType: 'tv', releaseDate: '2025-01-01', genreNames: ['Crime'], trendRank: { rank: 2 } },
    { status: 'Returning Series', numberOfSeasons: 1, seasons: [S(1, '2025-01-01')], lastEpisode: { airDate: '2026-09-27', season: 1 }, nextEpisode: { airDate: '2026-10-04', season: 1, episode: 9 } },
    'New Episodes', ['2025', '1 Season', 'Crime']],
  [{ mediaType: 'tv', releaseDate: '2026-09-01', genreNames: ['Drama', 'Crime'] },
    { status: 'Ended', type: 'Miniseries', numberOfSeasons: 1, seasons: [S(1, '2026-09-01')] },
    'New Limited Series', ['2026', 'Limited Series', 'Drama', 'Crime']],
  [{ mediaType: 'movie', releaseDate: '2018-04-25', voteAverage: 8.2, voteCount: 30000, genreNames: ['Adventure', 'Action'] },
    { runtime: 149 }, 'Highly Rated', ['2018', '2h 29m', 'Adventure', 'Action']],
  [{ mediaType: 'movie', releaseDate: '2025-11-26', voteAverage: 7.4, voteCount: 1900, genreNames: ['Animation', 'Comedy'] },
    { runtime: 108, revenue: 1.7e9 }, 'Box Office Hit', ['2025', '1h 48m', 'Animation', 'Comedy']],
  [{ mediaType: 'tv', releaseDate: '2010-09-20', voteAverage: 7.6, voteCount: 1600, genreNames: ['Crime', 'Drama'] },
    { status: 'Ended', numberOfSeasons: 10, seasons: [S(1, '2010-09-20'), S(10, '2019-09-27')], lastEpisode: { airDate: '2020-04-03', season: 10 } },
    'Binge-Worthy', ['2010', '10 Seasons', 'Crime', 'Drama']],
];
for (const [item, details, h, m] of detailCases) cases.push([item, h, m, details]);

let failures = 0;
for (const [item, wantHighlight, wantMeta, details] of cases) {
  const got = buildTagContent(item, NOW, details || null);
  const ok = got.highlight === wantHighlight && JSON.stringify(got.meta) === JSON.stringify(wantMeta);
  if (/\d/.test(got.highlight || '')) { console.error('highlight contains a number:', got.highlight); failures++; }
  if (!ok) {
    failures++;
    console.error('MISMATCH', JSON.stringify(item), '=>', JSON.stringify(got), 'wanted', wantHighlight, wantMeta);
  }
}
if (failures) { console.error(`TEST FAILED: ${failures} tag case(s)`); process.exit(1); }
console.log(`OK — ${cases.length} tag cases, no numbers in any highlight`);
