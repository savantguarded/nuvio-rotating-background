// Backdrop/logo picking from the combined details+images call.
const { pickBackdropPath, pickLogoPath } = require('../lib/tmdb');

const backdrops = [
  { file_path: '/en_text.jpg', iso_639_1: 'en', width: 3840, aspect_ratio: 1.778, vote_average: 9, vote_count: 50 },
  { file_path: '/small.jpg', iso_639_1: null, width: 1280, aspect_ratio: 1.778, vote_average: 8, vote_count: 20 },
  { file_path: '/square.jpg', iso_639_1: null, width: 3000, aspect_ratio: 1.0, vote_average: 8, vote_count: 20 },
  { file_path: '/ok_low.jpg', iso_639_1: null, width: 1920, aspect_ratio: 1.778, vote_average: 5.2, vote_count: 3 },
  { file_path: '/best.jpg', iso_639_1: null, width: 3840, aspect_ratio: 1.778, vote_average: 5.6, vote_count: 12 },
];
const got = pickBackdropPath(backdrops);
if (got !== '/best.jpg') throw new Error('expected the best textless, full-width, 16:9 backdrop, got ' + got);
if (pickBackdropPath(backdrops.slice(0, 3)) !== null) throw new Error('expected null when nothing qualifies');

const logos = [
  { file_path: '/fr.png', iso_639_1: 'fr', vote_average: 9, width: 500 },
  { file_path: '/en.svg', iso_639_1: 'en', vote_average: 9, width: 500 },
  { file_path: '/en.png', iso_639_1: 'en', vote_average: 5, width: 500 },
];
if (pickLogoPath(logos) !== '/en.png') throw new Error('expected English PNG logo');
console.log('OK — textless full-width backdrop and English PNG logo picked correctly');
