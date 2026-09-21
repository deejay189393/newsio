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
- **One search catalog, named "Newsio".** A single catalog owns search for the
  whole addon, so a query returns one result row -- labelled **Newsio** -- that
  queries newsdata.io live across every category, rather than filtering a local
  list. The topic catalogs are browse-only.
- **Pagination.** Catalogs declare `skip`, and Newsio translates Stremio's
  numeric offset into newsdata.io's cursor-based paging (see *Pagination* below).
- **Real metadata per item** — title, description, poster, backdrop, publish
  date, genre, source and author links — served from the addon's own `meta`
  handler.
- **Video stories are marked in the title.** A story with a playable video has
  its headline prefixed with a **`▶`**, and its first stream plays that video.
  The marker goes on the title because the title is the only text a catalog grid
  shows under a poster. Every story also offers a "read the article" link.
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
| `GET /:config/catalog/news/:topic/:extra?.json` | Headlines for one topic; handles `skip` |
| `GET /:config/catalog/news/search/search=:q.json` | The addon-wide search catalog |
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
npm test            # 270 tests
npm run test:coverage
```

Tests mock the newsdata.io API throughout — no key or network needed — and
coverage is pinned at **100%** of statements, branches, functions and lines by
a `coverageThreshold` in `package.json`, so a regression fails the build.

The configure page's inline script is additionally executed in a real DOM
(`test/configurePage.dom.test.js`, via jsdom) rather than only asserted on as
markup: the form is submitted, the topic bulk actions and the copy button are
clicked, and the install URL that comes out is decoded back through the
server's own config parser. Line coverage cannot see into a `<script>` that is
emitted as a string, so that page needs behavioural tests to be covered at
all.

## Deploying

The repo ships a `Dockerfile` and a `railway.json` that pins the Docker builder
and the `/health` healthcheck, so Railway (or anything else that runs a
container) builds and deploys it without further configuration. No environment
variables are required; `PORT` is injected by the platform.

### Optional environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Port to bind (set automatically by Railway; defaults to 3000) |
| `STREMIO_ADDONS_CONFIG_SIGNATURE` | Override the built-in stremio-addons.net signature (forks only; see below) |
| `STREMIO_ADDONS_CONFIG_ISSUER` | Override the signature issuer (defaults to `https://stremio-addons.net`) |

## Listing on stremio-addons.net

[stremio-addons.net](https://stremio-addons.net) verifies ownership by having
the addon echo a signature back in its manifest, as `stremioAddonsConfig`:

```json
"stremioAddonsConfig": { "issuer": "https://stremio-addons.net", "signature": "..." }
```

**This addon is already claimed.** The issued signature ships in
`src/manifest.js` and is served on every manifest response, configured and
unconfigured alike -- including the plain `/manifest.json` that the claim is
bound to. Nothing needs to be set on the deployment.

It is committed rather than kept in an environment variable on purpose. The
token reads like a credential, but it is handed verbatim to every client that
fetches the manifest, so it is public by construction: hiding it bought
nothing, while leaving the verified badge to vanish silently if the variable
were ever dropped. It is also bound to this addon's manifest URL, so it cannot
be reused to claim a different one.

Check it with:

```bash
curl -s https://newsio.up.railway.app/manifest.json | grep -o '"issuer":"[^"]*"'
```

### Claiming a fork

The committed signature will **not** validate for another host, so a fork
needs its own. Get one and override it from the environment rather than
editing the file:

1. **Sign in** at [stremio-addons.net](https://stremio-addons.net) with your
   Stremio account -- the Claim link only renders for signed-in users.
2. **Find the addon** in the catalog. If it is not listed yet, submit it at
   [/submit-addon](https://stremio-addons.net/submit-addon) using the
   unconfigured manifest URL, `https://<your-host>/manifest.json` -- not a
   configured one, since that carries an API key in the path.
3. **Click "Claim"** at the bottom of the addon's page and follow the
   ownership steps. The site issues a signature bound to that manifest URL.
4. **Set `STREMIO_ADDONS_CONFIG_SIGNATURE`** to it in your host's variables.
   Railway restarts on a variable change and the manifest is built per
   request, so it takes effect immediately -- no redeploy.
5. **Confirm** with the `curl` above and finish verification on their site.

`STREMIO_ADDONS_CONFIG_ISSUER` overrides the issuer, which defaults to
`https://stremio-addons.net` and only needs changing if they tell you to.

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
