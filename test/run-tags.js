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
];

let failures = 0;
for (const [item, wantHighlight, wantMeta] of cases) {
  const got = buildTagContent(item, NOW);
  const ok = got.highlight === wantHighlight && JSON.stringify(got.meta) === JSON.stringify(wantMeta);
  if (/\d/.test(got.highlight || '')) { console.error('highlight contains a number:', got.highlight); failures++; }
  if (!ok) {
    failures++;
    console.error('MISMATCH', JSON.stringify(item), '=>', JSON.stringify(got), 'wanted', wantHighlight, wantMeta);
  }
}
if (failures) { console.error(`TEST FAILED: ${failures} tag case(s)`); process.exit(1); }
console.log(`OK — ${cases.length} tag cases, no numbers in any highlight`);
