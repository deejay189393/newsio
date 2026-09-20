# Newsio — a Stremio news addon

Newsio turns live headlines from [newsdata.io](https://newsdata.io) into Stremio
catalogs: one catalog per topic you pick, searchable from inside Stremio, with
real metadata for every story and a playable stream when the story has video.

**Live instance:** https://newsio.up.railway.app/configure

---

## What it does

- **Your topics become your catalogs.** Pick Technology, Finance & Business,
  World, Sports, and so on; each selected topic appears in Stremio as its own
  catalog, named after the topic.
- **Search works inside Stremio.** Every catalog declares the `search` extra, so
  Stremio's search bar queries newsdata.io live rather than filtering a local list.
- **Pagination.** Catalogs declare `skip`, and Newsio translates Stremio's
  numeric offset into newsdata.io's cursor-based paging (see *Pagination* below).
- **Real metadata per item** — title, description, poster, backdrop, publish
  date, genre, source and author links — served from the addon's own `meta`
  handler.
- **Video-aware streams.** If a story has a video, its description is prefixed
  with **`[VIDEO]`** and the first stream plays that video. Every story also
  offers a "read the article" link.
- **Re-configurable.** Stremio's *Configure* button reopens the setup page with
  your current key, language and topics pre-filled.

### Why the custom `news` type

Items use a custom Stremio content type, `news`, plus the `nd_` id prefix.
Stremio routes a metadata request to whichever addon claims that type and
prefix, so this keeps Cinemeta and other metadata addons from ever being asked
to resolve a news id — they can't recognise it, and can't overwrite Newsio's
metadata with a bad match.

The trade-off: a custom type doesn't appear under Stremio's built-in
Movies/Series tabs. Newsio's catalogs show up on the Board/Discover screen and
in search, the same as other non-video addons.

---

## Endpoints

| Route | Purpose |
|---|---|
| `GET /configure` | Setup page — generates your personal install URL |
| `GET /:config/configure` | Re-configuration, pre-filled from your current settings |
| `GET /manifest.json` | Unconfigured manifest (tells Stremio setup is required) |
| `GET /:config/manifest.json` | Your manifest: one catalog per selected topic |
| `GET /:config/catalog/news/:topic/:extra?.json` | Headlines; handles `search` and `skip` |
| `GET /:config/meta/news/:id.json` | Full metadata for one story |
| `GET /:config/stream/news/:id.json` | Video stream (if any) + article link |
| `GET /health` | Health check used by Railway |

`catalog`, `meta` and `stream` are served by the official
[`stremio-addon-sdk`](https://github.com/Stremio/stremio-addon-sdk) router, so
extra-parameter parsing, config parsing, CORS and cache headers all follow the
addon protocol rather than a hand-rolled reimplementation. The manifest routes
are served directly, because the catalog list has to vary per user — something
the SDK's single static manifest can't express.

---

## How your settings are stored

They aren't — not on the server. Your API key, topics and language are encoded
into your own addon URL as one path segment, using the SDK's native convention:

```js
encodeURIComponent(JSON.stringify({ apiKey, topics, language }))
```

The deployment holds no database and no secrets. The flip side: **your install
URL contains your API key, so don't share it publicly.**

## Pagination

newsdata.io pages with an opaque `nextPage` cursor, not a page number — each
response only reveals the token for the *next* page. Stremio, meanwhile, asks
for a numeric `skip`. Newsio bridges the two by walking the cursor chain and
caching each page's token as it goes, so:

- scrolling forward costs exactly one upstream call per new page,
- revisiting a page costs none,
- and a deep, never-before-seen jump is capped at 5 sequential upstream calls,
  so one request can't burn your whole rate limit (past that it returns an
  empty page rather than hammering the API).

## Caching

Three in-memory TTL stores, each with its own lifetime and purpose:

| Store | TTL | Holds |
|---|---|---|
| `catalogCache` | 10 min | One page of results per (topic\|search, language) |
| `articleCache` | 1 hour | Individual stories by id, so `meta`/`stream` resolve without a second API call |
| `pageCursorCache` | 1 hour | The `nextPage` token for each page of each query |

All three are bounded, evicting oldest-first, so unique search queries can't
grow memory without limit. If an id isn't cached (expired, or the process
restarted), `meta`/`stream` fall back to a direct id lookup against
newsdata.io — so a story opened from your Stremio library still resolves days
later.

Everything is in-process, which suits a single container. `src/cache.js` is a
small `TTLCache` class behind a `get`/`set`/`has` API, so swapping in Redis or
SQLite for a multi-instance deployment means changing one file.

---

## Running locally

```bash
npm install
npm start           # http://localhost:3000/configure
```

```bash
npm test            # 198 tests
npm run test:coverage
```

Tests mock the newsdata.io API throughout — no key or network needed — and
coverage is pinned at **100%** of statements, branches, functions and lines by
a `coverageThreshold` in `package.json`, so a regression fails the build.

## Deploying

The repo ships a `Dockerfile` and a `railway.json` that pins the Docker builder
and the `/health` healthcheck, so Railway (or anything else that runs a
container) builds and deploys it without further configuration. No environment
variables are required; `PORT` is injected by the platform.

### Optional environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Port to bind (set automatically by Railway; defaults to 3000) |
| `STREMIO_ADDONS_CONFIG_SIGNATURE` | Listing signature from stremio-addons.net (see below) |
| `STREMIO_ADDONS_CONFIG_ISSUER` | Override the signature issuer (defaults to `https://stremio-addons.net`) |

## Listing on stremio-addons.net

[stremio-addons.net](https://stremio-addons.net) verifies ownership by having
the addon echo a signature back in its manifest, as `stremioAddonsConfig`:

```json
"stremioAddonsConfig": { "issuer": "https://stremio-addons.net", "signature": "..." }
```

Newsio reads that signature from `STREMIO_ADDONS_CONFIG_SIGNATURE` rather than
hardcoding it, so the credential never lands in this public repo and claiming
the addon needs no code change. To list it:

1. Sign in at stremio-addons.net and open the addon's page (or submit the
   manifest URL).
2. Click **Claim** and copy the signature it issues.
3. Set `STREMIO_ADDONS_CONFIG_SIGNATURE` to that value in your Railway service
   variables and redeploy.
4. The manifest now includes `stremioAddonsConfig`; finish verification on their
   site.

The manifest already carries everything else a listing needs: a stable `id`,
semver `version`, `name`, `description`, `logo`, `background` and `contactEmail`.

---

## Notes

- **newsdata.io free tier** is rate-limited and returns 10 articles per request.
  The caching above is tuned to stay within it. Empty catalogs usually mean a
  spent quota or a bad key — check your newsdata.io dashboard.
- **Articles aren't video files.** Most stories open in your browser via
  Stremio's `externalUrl` stream; only stories with a `video_url` actually play.

## License

MIT
