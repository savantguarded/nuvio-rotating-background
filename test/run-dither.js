// Verifies ditherOverlayAlpha actually does something (not a silent no-op —
// see the doc comment on it in lib/compose.js for why that was a real risk
// with a naive blend-mode approach) and that it stays within its claimed
// boundary: pixels that are fully transparent or fully opaque in the source
// overlay are left untouched, so the effect is confined to the actual
// gradient falloff band.
const sharp = require('sharp');
const { buildOverlaySvg, ditherOverlayAlpha } = require('../lib/compose');

async function main() {
  const width = 200;
  const height = 200;
  const overlay = buildOverlaySvg({ width, height, strength: 0.9 });

  const before = await sharp(overlay).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const dithered = await ditherOverlayAlpha(overlay, { amplitude: 6 });
  const after = await sharp(dithered).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  if (before.info.width !== after.info.width || before.info.height !== after.info.height) {
    throw new Error('dithering changed image dimensions');
  }

  const channels = before.info.channels;
  let changedInMidrange = 0;
  let changedAtBoundary = 0;
  let midrangeCount = 0;

  for (let i = 0; i < before.data.length; i += channels) {
    const aBefore = before.data[i + 3];
    const aAfter = after.data[i + 3];
    if (aBefore <= 0 || aBefore >= 255) {
      if (aAfter !== aBefore) changedAtBoundary++;
    } else {
      midrangeCount++;
      if (aAfter !== aBefore) changedInMidrange++;
    }
  }

  console.log(
    `midrange pixels: ${midrangeCount}, changed: ${changedInMidrange}, ` +
    `boundary pixels changed (should be 0): ${changedAtBoundary}`
  );

  if (midrangeCount === 0) {
    throw new Error('test overlay has no mid-alpha gradient band to dither — test setup is wrong');
  }
  if (changedInMidrange === 0) {
    throw new Error('dithering had no effect on any mid-alpha pixel — looks like a no-op');
  }
  if (changedAtBoundary !== 0) {
    throw new Error('dithering touched a fully-transparent or fully-opaque pixel — should be self-limiting to the gradient band');
  }

  console.log('OK — dither has a real, measurable effect and stays confined to the gradient falloff band');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
