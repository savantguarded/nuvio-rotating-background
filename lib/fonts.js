const fs = require('fs');
const path = require('path');
const os = require('os');

// Vercel's Node serverless runtime ships with NO fonts and no fontconfig
// setup — sharp's SVG-with-text compositing (the genre/trend tag row in
// lib/compose.js, and the no-logo text fallback in api/background.js) goes
// through librsvg -> Pango -> fontconfig under the hood, and with nothing
// registered, every glyph silently renders as a "tofu" placeholder box
// instead of throwing. This was invisible in local dev (both the cloud
// sandbox and Charles's machine have real system fonts already) and only
// surfaced once checked against the live endpoint.
//
// Fix: bundle DejaVu Sans (assets/fonts/, permissively licensed — see
// assets/fonts/LICENSE) and point fontconfig at it via FONTCONFIG_PATH,
// aliasing Arial/Helvetica/sans-serif to it so every existing
// `font-family="Arial, Helvetica, sans-serif"` string in the codebase picks
// it up with no changes to the SVG-building code itself.
//
// This has to run once, before the first SVG-with-text render in a given
// Lambda instance (fontconfig reads FONTCONFIG_PATH lazily but caches its
// config after first use), so call ensureFontsConfigured() at the top of
// any module that builds text SVGs, before doing so.
let configured = false;

function ensureFontsConfigured() {
  if (configured) return;
  configured = true;

  try {
    const fontDir = path.join(__dirname, '..', 'assets', 'fonts');
    const templatePath = path.join(__dirname, '..', 'assets', 'fontconfig', 'fonts.conf');
    if (!fs.existsSync(fontDir) || !fs.existsSync(templatePath)) return;

    // Lambda's filesystem is read-only outside /tmp, so the resolved config
    // (with the real absolute font dir baked in) and fontconfig's own cache
    // both have to live there rather than next to the checked-in template.
    const outDir = path.join(os.tmpdir(), 'nuvio-fontconfig');
    fs.mkdirSync(outDir, { recursive: true });

    const template = fs.readFileSync(templatePath, 'utf8');
    const resolved = template.replace('__FONT_DIR__', fontDir);
    const outPath = path.join(outDir, 'fonts.conf');
    fs.writeFileSync(outPath, resolved);

    // Don't clobber an explicit FONTCONFIG_PATH someone else set on purpose.
    if (!process.env.FONTCONFIG_PATH) {
      process.env.FONTCONFIG_PATH = outDir;
    }
  } catch (err) {
    // Best-effort: if this fails for any reason (read-only fs in some
    // exotic environment, missing assets, etc.), fall through to whatever
    // fonts the host already has rather than crashing image generation over
    // a text-rendering nicety.
    console.error('font setup failed, falling back to host fonts:', err);
  }
}

module.exports = { ensureFontsConfigured };
