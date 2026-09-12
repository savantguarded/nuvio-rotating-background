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
| `POOL` | `trending` | `trending` (TMDB trending/week merged with movie+TV popular, deduped) \| `now_playing` \| `airing_today` \| `popular` — `trending` is the active default |
| `SHOW_LOGO` | `true` | set `false` to skip the title logo overlay entirely |
| `OVERLAY_STRENGTH` | `0.72` | 0–1+, base darkness of the gradient/vignette. This is a floor, not a fixed value — see below |
| `BLUR_SIGMA` | `1.2` | softens the backdrop before darkening; `0` disables. Also shrinks output size a bit (less detail to encode) |
| `JPEG_QUALITY` | `84` | output JPEG quality |
| `BACKDROP_SIZE` | `w1280` | TMDB backdrop size requested — see note below |
| `BG_WIDTH` / `BG_HEIGHT` | `1920` / `1080` | output canvas size |

`?pool=` overrides the env var per-request too, handy for previewing e.g. `.../api/background?pool=airing_today` in a browser tab without redeploying.

### Readability + pixelation fixes (Sept 2026)

Charles flagged two things on real devices: bright posters (snow, daylight skies) still read poorly behind Nuvio's profile-picker text, and dark scenes looked blocky/pixelated.

**Readability** was a real bug, not just a tuning knob: the darkening gradient was left-side-weighted and fully cleared by 75% of the canvas width, so the right two-thirds of the band where Nuvio actually renders its text (profile row, "Add Profile", "Hold to manage profile") stayed under-darkened on bright backdrops. Two changes: the left gradient's falloff now reaches the far edge instead of clearing early, and `OVERLAY_STRENGTH` is now a *floor* — each request samples the backdrop's actual brightness in that zone (`lib/compose.js: measureUiZoneBrightness`) and boosts the effective strength above the floor when the source is bright enough to need it, capped so it never fully blacks out the image. Verified against a pristine copy of the previous code: a bright synthetic backdrop that measured 69–83/255 in the text zone (unreadable) now measures 18–25/255 (comfortably dark), at roughly the same output size.

**Pixelation**: `BACKDROP_SIZE` was requesting TMDB's `w1920`, which isn't one of TMDB's documented backdrop sizes (`w300`/`w780`/`w1280`/`original`) — an undocumented size risks the CDN quietly resolving to something smaller than our 1920x1080 canvas, which means Sharp was upscaling that into the full frame, and upscaled low-detail source shows up as soft blockiness first in dark, low-contrast scenes. Switched to `w1280`, a real documented size — a modest, predictable 1.5x upscale that the blur pass below smooths over, and a much smaller/faster TMDB fetch than requesting `original` (which can be full 4K for popular titles). A grain/dither layer was also tried as a direct fix for JPEG's own blocky quantization in flat dark gradients (the standard trick for this), but measured against the old pipeline it either did nothing at a size-neutral opacity or needed 2-4x the output bytes to move the needle — not a trade worth making for "stay light." Kept instead: a small blur pass (reduces high-frequency detail *and* shrinks output size) and a modest quality bump (82→84), which gave a real, cheap reduction in visible blocking without the bytes cost. `test/verify-fixes.js` has the before/after numbers if this needs revisiting.

## Cost

No caching means Sharp runs on every real fetch. That's fine here because the only caller is Nuvio on app open, for one person — a handful of runs a day, nowhere near Hobby plan CPU-hour limits. If this ever gets hit at real traffic volume (many devices/users), reintroduce a short `s-maxage` window; the code was structured that way originally and it's a one-line change back.

If TMDB or the image fetch fails for any reason, the endpoint falls back to a plain dark gradient instead of erroring, so Nuvio's background never breaks.

## Files

- `api/background.js` — the Vercel serverless function (the actual endpoint)
- `lib/tmdb.js` — TMDB pool fetching + logo lookup
- `lib/compose.js` — Sharp compositing: crop-to-fill, gradient overlay, logo placement
- `test/` — mocked end-to-end tests (`npm test`), no TMDB key needed to run them
