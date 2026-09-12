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
| `POOL` | `trending` | `trending` \| `now_playing` \| `airing_today` \| `popular` — currently only `trending` is in active use |
| `SHOW_LOGO` | `true` | set `false` to skip the title logo overlay entirely |
| `OVERLAY_STRENGTH` | `0.55` | 0–1, how dark the gradient/vignette is |
| `BG_WIDTH` / `BG_HEIGHT` | `1920` / `1080` | output canvas size |

`?pool=` overrides the env var per-request too, handy for previewing e.g. `.../api/background?pool=airing_today` in a browser tab without redeploying.

## Cost

No caching means Sharp runs on every real fetch. That's fine here because the only caller is Nuvio on app open, for one person — a handful of runs a day, nowhere near Hobby plan CPU-hour limits. If this ever gets hit at real traffic volume (many devices/users), reintroduce a short `s-maxage` window; the code was structured that way originally and it's a one-line change back.

If TMDB or the image fetch fails for any reason, the endpoint falls back to a plain dark gradient instead of erroring, so Nuvio's background never breaks.

## Files

- `api/background.js` — the Vercel serverless function (the actual endpoint)
- `lib/tmdb.js` — TMDB pool fetching + logo lookup
- `lib/compose.js` — Sharp compositing: crop-to-fill, gradient overlay, logo placement
- `test/` — mocked end-to-end tests (`npm test`), no TMDB key needed to run them
