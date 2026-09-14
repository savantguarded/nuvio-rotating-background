# Nuvio Rotating Background

A serverless endpoint that generates a single stable image URL. Every time something actually fetches that URL, it picks a random title from TMDB's trending pool, darkens the backdrop with a gradient overlay, and stamps the title's logo bottom-right so it stays clear of Nuvio's own profile list on the left.

Point Nuvio's custom profile background field at this one URL. You never change the URL again; a new image renders on every request.

## Why this shape

Nuvio's custom background field takes one static link, not a list. There's no way to hand it multiple images directly. So the variation has to happen server-side: same URL, different bytes on every fetch.

Confirmed behavior (Charles, Sept 2026): Nuvio fetches this URL fresh each time the app is opened, rather than caching it indefinitely across launches. So "random pick + never cache the response" is enough to get a new image on every app open — no time-bucketing needed.

```js
Math.floor(Math.random() * pool.length) // pick a title, every single request
```

`Cache-Control: no-store` on the response means nothing (Vercel's edge included) is allowed to hand back a stale copy — every fetch re-runs the pick and re-renders.

## Setup

1. `npm install`
2. Get a TMDB API key (you already have one from Top-20/Next Up; reuse it or create a separate one, your call). Set it as `TMDB_API_KEY` in the Vercel project's env vars.
3. Deploy (see below).
4. In Nuvio: Settings → Profile → Custom Background → paste `https://<your-deployment>.vercel.app/api/background`.

## Tuning (Vercel env vars, no code changes)

| Var | Default | What it does |
|---|---|---|
| `TMDB_API_KEY` | — | required |
| `POOL` | `trending` | `trending` (US-only, popularity-sorted — see below) \| `now_playing` \| `airing_today` \| `popular` — `trending` is the active default |
| `SHOW_LOGO` | `true` | set `false` to skip the title logo overlay entirely |
| `OVERLAY_STRENGTH` | `0.9` | 0–1+, base darkness of the gradient/vignette. This is a floor, not a fixed value — see below |
| `BLUR_SIGMA` | `0.6` | very light softening of the backdrop, mainly to settle JPEG quantization in flat dark scenes; `0` disables. Kept deliberately low — see "Sharpness" below |
| `SHARPEN` | `true` | applies a mild unsharp mask after resize, to counter the softness a cover-fit resize/re-encode introduces; set `false` to disable |
| `JPEG_QUALITY` | `86` | output JPEG quality |
| `BACKDROP_SIZE` | `original` | TMDB backdrop size requested — see "Sharpness" note below |
| `BG_WIDTH` / `BG_HEIGHT` | `1920` / `1080` | output canvas size |

`?pool=` overrides the env var per-request too, handy for previewing e.g. `.../api/background?pool=airing_today` in a browser tab without redeploying.

### Pool: bigger, still US-only, still "most popular" (Sept 14 fix)

The `trending` pool used to be just `trending/movie/week` + `trending/tv/week` (~20 items each before filtering), scoped to US content via a language-heuristic for movies (`original_language === 'en'`, which let in non-US English-language films — UK, Australian, Irish...) and `origin_country` for TV.

It now merges two layers:
- **Discover, popularity-sorted, US-only** — `/discover/movie` and `/discover/tv`, both with `with_origin_country=US` (a real TMDB data field: production/origin country, not a language proxy) and `sort_by=popularity.desc`, pages 1-2 each (top 80 per media type), with a light `vote_count.gte` floor so a low-signal title can't sneak in on a transient popularity spike. This is the bulk of the pool and the part that answers "expand it, but keep it to the most popular stuff" — sorted by popularity, so the pool stays weighted toward recognizable titles even as it grows.
- **Trending, for freshness** — the weekly trending lists, folded in on top for titles that are spiking right now but haven't caught up in the popularity-sorted discover pages yet. TV trending items are filtered by `origin_country` directly (unchanged, already reliable); a trending *movie* only makes the cut if its id also appears in the discover-US-movies set above (movie list items don't carry `origin_country` at all — only the details endpoint does — so membership in the already-US-filtered discover set is used as the precise check, replacing the old language heuristic).

Everything is deduped by `mediaType:id` before a title's picked. Net effect: the pool went from ~30-40 US-filtered items to on the order of 100+, while every item in it is still either a popularity-sorted US discover result or a US-confirmed trending one — no widening of "US only" or "most popular," just more titles within those two constraints.

### Excluding non-show TV/movie bloat (Sept 14, second pass)

Charles flagged talk shows showing up in the pool. TMDB's US-scoped popularity charts regularly surface long-running talk shows, news programs, reality/game shows, and soaps — real ratings winners, but not "a show" in the Netflix-picker sense, and their images are usually a stage photo or title card rather than the kind of backdrop this is for. Same issue on the movie side with "TV Movie" (made-for-TV specials, reunions, concert films) occasionally cracking the popularity charts.

Two layers, since `trending/*` doesn't support genre filtering server-side but `discover/*` does:
- `/discover/movie` and `/discover/tv` now also send `without_genres` — `10770` (TV Movie) for movies, `10763,10764,10766,10767` (News, Reality, Soap, Talk) for TV — so TMDB excludes them before they ever take up one of the popularity-sorted slots.
- A client-side check on `genre_ids` (present on every TMDB list result) is applied to *every* item regardless of source, as the backstop for `trending/*` and a safety net in case a bloat title slips past the server-side filter some other way.

### Faster load, and pool caching (Sept 14, second pass)

Charles reported ~2-3s load time. The pool-expansion fix above meant every single request fired 6 TMDB list calls (4 discover pages + 2 trending) before it could even pick a title — the biggest chunk of that latency, and almost entirely wasted, since the pool composition doesn't meaningfully change minute to minute.

Fixed by caching, mirroring the existing best-effort `lastPickedId` in-memory pattern (per warm Lambda instance, not durable across cold starts — fine for personal single-instance traffic):
- The assembled pool (`fetchPool` in `lib/tmdb.js`) is cached for 10 minutes. Most requests now skip straight from "warm instance" to "pick + render" with zero TMDB list calls.
- A title's logo lookup (`fetchLogo`) is cached for 1 hour, so re-picking a title already seen in that window skips the `/images` metadata call too.

Neither changes what gets served — the pool itself, and any given title's logo, don't need to be millisecond-fresh — only how often TMDB gets asked for them. `BACKDROP_SIZE=original` (the Sept 14 sharpness fix) and the actual image render are unchanged and still run per-request, since those *do* need to vary every time.

### Readability + pixelation fixes (Sept 2026)

Charles flagged two things on real devices: bright posters (snow, daylight skies) still read poorly behind Nuvio's profile-picker text, and dark scenes looked blocky/pixelated.

**Readability** was a real bug, not just a tuning knob: the darkening gradient was left-side-weighted and fully cleared by 75% of the canvas width, so the right two-thirds of the band where Nuvio actually renders its text (profile row, "Add Profile", "Hold to manage profile") stayed under-darkened on bright backdrops. Two changes: the left gradient's falloff now reaches the far edge instead of clearing early, and `OVERLAY_STRENGTH` is now a *floor* — each request samples the backdrop's actual brightness in that zone (`lib/compose.js: measureUiZoneBrightness`) and boosts the effective strength above the floor when the source is bright enough to need it, capped so it never fully blacks out the image. Verified against a pristine copy of the previous code: a bright synthetic backdrop that measured 69–83/255 in the text zone (unreadable) now measures 18–25/255 (comfortably dark), at roughly the same output size.

`OVERLAY_STRENGTH` was later nudged from `0.72` to `0.8`, then to `0.9` (Sept 14, third pass) — Charles asked for more darkness across the board twice in a row. Still just the floor; the adaptive boost on top (capped at 1.35) is unchanged, so a very bright backdrop can still push past 0.9, it just no longer needs to to look reasonably dark.

**Pixelation** (original fix, Sept 12): `BACKDROP_SIZE` was requesting TMDB's `w1920`, which isn't one of TMDB's documented backdrop sizes (`w300`/`w780`/`w1280`/`original`) — an undocumented size risks the CDN quietly resolving to something smaller than our 1920x1080 canvas, which means Sharp was upscaling that into the full frame. Switched to `w1280` at the time, a real documented size but still a 1.5x upscale.

### Sharpness (Sept 14 fix)

Charles reported the images were still too soft/blurry. Root cause, found by an A/B comparison against a real downsampled-master vs. upsampled-w1280 source: `w1280` meant every backdrop got upscaled ~1.5x to fill the 1920x1080 canvas *before* any blur even ran — upscaling is inherently soft — and on top of that, `BLUR_SIGMA` (1.2–1.4) turned out to be a real, visible blur rather than a subtle touch-up: measured directly, sigma needs to be roughly ≥0.6 before libvips' gaussian blur does anything detectable at this resolution at all, so 1.2–1.4 was well past "barely there."

Fixed by changing the two things that were actually compounding into "blurry":
- `BACKDROP_SIZE` now defaults to `original` — TMDB's true source resolution (typically ≥1920px wide for anything popular enough to be in this pool), so Sharp only ever *downsamples* to fill the canvas, never upscales. This is an internal TMDB→Vercel fetch getting bigger, not the delivered image — output bytes are still governed by `BG_WIDTH`/`BG_HEIGHT`/`JPEG_QUALITY` below, since Sharp always re-encodes at the target canvas size regardless of source size.
- `BLUR_SIGMA` dropped from 1.2–1.4 to `0.6` — light enough to still settle flat-gradient JPEG quantization in dark scenes, below the threshold where it reads as visible softening.
- A new `SHARPEN` step (mild unsharp mask, on by default) counters the residual softness a cover-fit resize/re-encode naturally introduces.

Verified with a controlled before/after render (same source photo, `w1280`-then-upscale vs. `original`-then-downsample): the fixed pipeline is visibly crisper on fine detail (rock texture, distant terrain, cloud structure) at roughly 1.5–2x the file size (~85KB → ~130-165KB for a 1920x1080 JPEG) — still light for a background fetched once per app open, not "too large."

A grain/dither layer was tried earlier as a direct fix for JPEG's own blocky quantization in flat dark gradients (the standard trick for this), but measured against the pipeline it either did nothing at a size-neutral opacity or needed 2-4x the output bytes to move the needle — not a trade worth making.

## Cost

No caching means Sharp runs on every real fetch. That's fine here because the only caller is Nuvio on app open, for one person — a handful of runs a day, nowhere near Hobby plan CPU-hour limits. If this ever gets hit at real traffic volume (many devices/users), reintroduce a short `s-maxage` window; the code was structured that way originally and it's a one-line change back.

If TMDB or the image fetch fails for any reason, the endpoint falls back to a plain dark gradient instead of erroring, so Nuvio's background never breaks.

## Files

- `api/background.js` — the Vercel serverless function (the actual endpoint)
- `lib/tmdb.js` — TMDB pool fetching + logo lookup
- `lib/compose.js` — Sharp compositing: crop-to-fill, gradient overlay, logo placement
- `test/` — mocked end-to-end tests (`npm test`), no TMDB key needed to run them
