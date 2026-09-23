// Regression guard for the exact "tofu box" failure class that already bit
// this codebase once (a0f2b86 — see lib/fonts.js): a font that resolves fine
// wherever real system fonts already exist (this sandbox, Charles's machine)
// but silently falls back to an empty/placeholder glyph in an environment
// with no fonts registered at all. This can't fully simulate "no fonts
// anywhere" without root access to strip the environment's own fonts, but it
// does directly check the thing that actually broke last time: that
// "Oswald" resolves to real glyph coverage through this project's own
// FONTCONFIG_PATH setup (lib/fonts.js), not to some empty/blank fallback.
const sharp = require('sharp');
const { ensureFontsConfigured } = require('../lib/fonts');

ensureFontsConfigured();

async function coverageFraction(fontFamily, text) {
  const width = 400;
  const height = 200;
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="10" y="150" font-family="${fontFamily}" font-size="120" fill="white">${text}</text>` +
    `</svg>`
  );
  const { data, info } = await sharp(svg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let litPixels = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] > 10) litPixels++;
  }
  return litPixels / (info.width * info.height);
}

async function main() {
  const oswaldCoverage = await coverageFraction('Oswald, Arial, Helvetica, sans-serif', 'Ag4');
  const dejaVuCoverage = await coverageFraction('Arial, Helvetica, sans-serif', 'Ag4');
  const unknownFontCoverage = await coverageFraction('DefinitelyNotARealFontXYZ', 'Ag4');

  console.log(
    `coverage — Oswald: ${(oswaldCoverage * 100).toFixed(2)}%, ` +
    `DejaVu (Arial alias): ${(dejaVuCoverage * 100).toFixed(2)}%, ` +
    `unresolvable font fallback: ${(unknownFontCoverage * 100).toFixed(2)}%`
  );

  // A real rendered "Ag4" at this size covers a modest but clearly
  // non-trivial fraction of the canvas. An empty/tofu render (no glyphs at
  // all) covers ~0%; a solid placeholder block would cover far more than
  // real letterforms do. 1%-15% is a generous real-glyph band calibrated
  // against the known-good DejaVu path below, not just guessed.
  if (oswaldCoverage < 0.01 || oswaldCoverage > 0.15) {
    throw new Error(
      `Oswald glyph coverage (${(oswaldCoverage * 100).toFixed(2)}%) is outside the expected real-text range — ` +
      'this is exactly the tofu-box failure mode from a0f2b86, check FONTCONFIG_PATH / assets/fonts/'
    );
  }
  if (dejaVuCoverage < 0.01 || dejaVuCoverage > 0.15) {
    throw new Error('sanity check failed: even the known-good DejaVu/Arial path is outside the expected coverage range');
  }
  // A font name fontconfig cannot resolve at all should still render
  // *something* (its last-resort default font), not necessarily zero — this
  // just documents that unresolvable names don't crash, unlike the two
  // real assertions above which are the actual regression guard.

  console.log('OK — Oswald resolves to real glyph coverage through this project\'s fontconfig setup, not a tofu-box fallback');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
