// Regression guard for the exact "tofu box" failure class that already bit
// this codebase once (a0f2b86 — see lib/fonts.js): a font that resolves fine
// wherever real system fonts already exist (this sandbox, Charles's machine)
// but silently falls back to an empty/placeholder glyph in an environment
// with no fonts registered at all. This can't fully simulate "no fonts
// anywhere" without root access to strip the environment's own fonts, but it
// does directly check the thing that actually broke last time: that the
// tag-row font ("Manrope" since Sept 30, previously "Oswald") resolves to real glyph coverage through this project's own
// FONTCONFIG_PATH setup (lib/fonts.js), not to some empty/blank fallback.
const sharp = require('sharp');
const { ensureFontsConfigured } = require('../lib/fonts');

ensureFontsConfigured();

async function renderRaw(fontFamily, text, weight = 400) {
  const svg = Buffer.from(
    `<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="10" y="150" font-family="${fontFamily}" font-weight="${weight}" font-size="120" fill="white">${text}</text>` +
    `</svg>`
  );
  return (await sharp(svg).ensureAlpha().raw().toBuffer());
}

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
  const manropeCoverage = await coverageFraction('Manrope', 'Ag4');
  const dejaVuCoverage = await coverageFraction('Arial, Helvetica, sans-serif', 'Ag4');

  console.log(
    `coverage — Manrope: ${(manropeCoverage * 100).toFixed(2)}%, ` +
    `DejaVu (Arial alias): ${(dejaVuCoverage * 100).toFixed(2)}%`
  );

  // A real rendered "Ag4" at this size covers a modest but clearly
  // non-trivial fraction of the canvas. An empty/tofu render covers ~0%; a
  // solid placeholder block would cover far more. 1%-15% is calibrated
  // against the known-good DejaVu path.
  if (manropeCoverage < 0.01 || manropeCoverage > 0.15) {
    throw new Error(
      `Manrope glyph coverage (${(manropeCoverage * 100).toFixed(2)}%) is outside the expected real-text range — ` +
      'this is exactly the tofu-box failure mode from a0f2b86, check FONTCONFIG_PATH / assets/fonts/'
    );
  }
  if (dejaVuCoverage < 0.01 || dejaVuCoverage > 0.15) {
    throw new Error('sanity check failed: even the known-good DejaVu/Arial path is outside the expected coverage range');
  }

  // Real glyphs aren't enough on their own: a missing Manrope would quietly
  // render in DejaVu instead. The pixels must differ from DejaVu's, and the
  // three bundled weights must differ from each other (i.e. the Medium and
  // SemiBold instances the tag row asks for actually resolve).
  const dejaVu = await renderRaw('DejaVu Sans', 'Ag4');
  const byWeight = {};
  for (const w of [400, 500, 600]) byWeight[w] = await renderRaw('Manrope', 'Ag4', w);
  if (byWeight[400].equals(dejaVu)) throw new Error('"Manrope" rendered identically to DejaVu — the bundled font is not being picked up');
  if (byWeight[400].equals(byWeight[500]) || byWeight[500].equals(byWeight[600])) {
    throw new Error('Manrope weights 400/500/600 render identically — a static weight instance is missing from assets/fonts/');
  }

  console.log('OK — Manrope (400/500/600) resolves to real, distinct glyphs through this project\'s fontconfig setup');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
