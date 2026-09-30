#!/usr/bin/env node
// Pre-renders a set of backgrounds for GitHub Pages (see api/background.js
// for why). Run by .github/workflows/prerender.yml; needs TMDB_API_KEY.
//
//   node scripts/prerender.js [outDir]   (default: ./site)
//
// Writes <outDir>/bg/00.jpg... plus <outDir>/manifest.json. Exits non-zero
// if fewer than MIN_OK renders succeed, so a TMDB outage never replaces a
// good published set with a thin or empty one.
const fs = require('fs');
const path = require('path');
const { fetchPool } = require('../lib/tmdb');
const { renderItem, envConfig } = require('../lib/render');

const COUNT = Number(process.env.PRERENDER_COUNT || 30);
const MIN_OK = Math.min(10, COUNT);
const CONCURRENCY = 4;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const outDir = path.resolve(process.argv[2] || 'site');
  const bgDir = path.join(outDir, 'bg');
  fs.mkdirSync(bgDir, { recursive: true });

  const pool = await fetchPool(process.env.POOL || 'trending');
  if (!pool.length) throw new Error('empty pool');
  // Oversample so a few failed renders (no backdrop, fetch error) still
  // leave a full set.
  const candidates = shuffle(pool).slice(0, Math.min(pool.length, COUNT + 8));
  const cfg = envConfig();
  const results = [];
  let next = 0;

  async function worker() {
    while (results.length < COUNT && next < candidates.length) {
      const item = candidates[next++];
      try {
        const { image, tags, timing } = await renderItem(item, cfg);
        if (results.length >= COUNT) return;
        const file = `bg/${String(results.length).padStart(2, '0')}.jpg`;
        results.push({ file, item, tags, bytes: image.length });
        fs.writeFileSync(path.join(outDir, file), image);
        console.log(`${file}  ${item.title}  [${[tags.highlight, ...tags.meta].filter(Boolean).join(' | ')}]  ${Math.round(image.length / 1024)}KB compose=${timing.compose}ms`);
      } catch (err) {
        console.warn(`skip ${item.title}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (results.length < MIN_OK) {
    throw new Error(`only ${results.length} renders succeeded (need ${MIN_OK}); not publishing`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    count: results.length,
    items: results.map((r) => ({
      file: r.file,
      title: r.item.title,
      mediaType: r.item.mediaType,
      tmdbId: r.item.id,
      highlight: r.tags.highlight,
      meta: r.tags.meta,
      bytes: r.bytes,
    })),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>Nuvio backgrounds</title>' +
      '<p>Pre-rendered backgrounds for the Nuvio profile screen. The endpoint is ' +
      '<code>https://nuvio-rotating-background.vercel.app/api/background</code>.</p>' +
      '<p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>'
  );
  console.log(`\nwrote ${results.length} backgrounds + manifest to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
