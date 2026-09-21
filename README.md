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
- **20 stories per page, and pagination that works.** Catalogs declare `skip`
  *with explicit step options*, which is what lets a page be anything other
  than 100 items (see *Pagination* below).
- **No syndicated duplicates.** newsdata.io is asked to collapse the same story
  republished by a dozen outlets (`removeduplicate`), which on a technology
  feed drops the result count by about a third.
- **Real tags per story.** The detail page shows the story's subject and its
  own keywords — "Technology | Security", "Divorce | Child Custody |
  Artificial Intelligence" — rather than the useless `top` that newsdata.io
  stamps on half its feed (see *Tags* below).
- **Content farms and affiliate posts filtered** as far as the API allows
  (see *Ads* below).
- **Real metadata per item** — title, description, poster, backdrop, publish
  date, genre, source and author links — served from the addon's own `meta`
  handler.
- **Video stories are marked in the title — and actually play.** A story whose
  video Stremio can really open has its headline prefixed with a **`▶`**, and
  its first stream is a `url` (direct media) or `ytId` (YouTube), so the player
  opens it. The marker goes on the title because that is the only text a
  catalog grid shows under a poster, and it appears *only* when playback will
  genuinely work: newsdata.io also returns embed pages, which can only be
  handed to a browser and so are left unmarked. Every story also offers a
  "read the article" link.
- **Configuration is mandatory.** The manifest sets
  `behaviorHints.configurationRequired`, so Stremio hides *Install* entirely and
  shows *Configure* instead, pointing at `/configure`. A configuration only
  counts as complete with **both** an API key and at least one topic -- a URL
  carrying one but not the other is treated exactly like no configuration at
  all, rather than installing into a permanently empty state.
- **Re-configurable.** Stremio's *Configure* button reopens the setup page with
  your current key, language and topics pre-filled.

### Why there is no `config` array

The manifest deliberately omits the SDK's native `config` array. Setting it
makes the SDK generate its own flat settings form and route the landing page
to it, which would replace the `/configure` page here (topic checkboxes,
language picker, install-link builder). `behaviorHints.configurable` plus a
page served at `/configure` is the documented way to keep a custom
configuration page.

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
| `GET /:config/catalog/news/:topic/:extra?.json` | Headlines for one topic (20 per page); handles `skip` |
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

Two mismatches have to be bridged here, and getting either wrong breaks
scrolling entirely.

**Upstream:** newsdata.io pages with an opaque `nextPage` cursor, not a page
number — each response only reveals the token for the *next* page, and returns
at most 10 articles (its `size` parameter is rejected outright above that on
the free tier). So a 20-item catalog page is assembled from two upstream calls,
and reaching page N means having walked 0..N-1.

**Downstream:** `skip` is an absolute item offset, not a page number. Crucially,
the addon protocol says *"the standard page size in Stremio is 100, so the skip
value will be a multiple of 100; if you return less than 100 items, Stremio will
consider this to be the end of the catalog."* A 20-item page with no declared
step is therefore treated as the **entire** catalog — scrolling never asks for
more. Newsio declares `skip` with explicit `options` (`"0"`, `"20"`, `"40"`, …),
which is the documented way to set a page size other than 100 and is what makes
pagination work at all.

Each page's cursor is cached as it is walked, so:

- scrolling forward costs exactly two upstream calls per new page,
- revisiting a page costs none,
- a page already known to be the last ends pagination without a call,
- and a deep, never-before-seen jump is capped (`MAX_PAGE_WALK`) so one request
  can't burn your whole rate limit.

`skip` is honoured exactly, including values that don't land on a page
boundary: the offset is mapped onto upstream pages by arithmetic and the
result sliced, rather than rounded down to the containing page.

## Article text

Newsio never truncates. `description` is served in full — it runs to roughly a
thousand characters on some stories — and the detail page adds a
`source · byline · date` line beneath it.

One thing to know about the free tier: newsdata.io fills `content`,
`ai_summary` and several other fields with the literal string
`ONLY AVAILABLE IN PAID PLANS`. Those are treated as absent, so an upsell
string can never reach a reader as though it were the article.

## Tags

The `genres` field carries the story's tag row. Two things go into it.

**Categories.** newsdata.io stamps `top` on roughly half of everything it
returns, and it is usually first in the `category` array — so serving that
field verbatim labelled most stories "top" and said nothing about any of them.
`top` is a feed designation, not a subject, and is dropped. Real categories are
shown under the same names the configure page uses (`business` →
"Finance & Business"). A story tagged with more than three categories is
ignoring the taxonomy rather than using it — one CNN story in a sample of 79
came back tagged with *twelve* — so its categories are dropped entirely.

**Keywords.** Present on about 82% of stories, typically three each, and
genuinely specific ("artificial intelligence", "gen z", "digital wallet").
They are the publisher's own tags, though, so they also carry house noise,
which is filtered:

| Dropped | Example |
|---|---|
| Format tags | `latest news`, `breaking news`, `headlines` |
| CMS slug families | `underscored-coffee`, `underscored-testing`, … |
| Ticker families | `eth-usd`, `btc-usd`, `xzc-usd` |
| Author handles | `yashu_crypto` |
| Site navigation | `home page 3`, `yahoo feed` |
| The publisher's own name | `dailymail` on a Mail Online story |
| Whole clauses | `sixth edition of mangaluru technovanza -2026` |

Publisher text also arrives HTML-escaped — a real tag row rendered
`Telco &amp; Isp` — so titles, descriptions and keywords are entity-decoded
once at the API boundary. Everything downstream is JSON for Stremio rather
than markup, so the rest of the addon only ever sees real characters.

A family is only treated as a CMS taxonomy when two or more keywords share a
hyphen segment, so a lone `sci-fi` survives as the real tag it is.

What is left is rendered in Title Case — every word starts with a capital,
including both halves of a hyphenated compound (`sci-fi` → `Sci-Fi`,
`multi-asset trading` → `Multi-Asset Trading`). newsdata.io returns keywords
entirely in lower case (all 386 of them across a 102-story sample), but the
input is normalised rather than trusted, so an upstream change to SHOUTING or
mixed casing still renders the same way. Known initialisms stay fully upper
(`ai` → `AI`, `nasa` → `NASA`), because "AI" is right where "Ai" is simply
wrong. The row is capped at six.

## Ads

**newsdata.io has no advertisement flag.** Tested directly: the API exposes
`datatype` (`news`, `blog`, `review`, `multimedia`, `podcast`, `analysis`) and
a `duplicate` boolean, and nothing that marks sponsored or affiliate content. A
plain affiliate post — *"Power outages happen: save up to 57% on EcoFlow power
stations"*, USA Today — arrives as `datatype: "news"`, indistinguishable from
reporting. There is no deterministic tag to filter on.

Two signals that *do* exist are used instead:

- **`source_priority`** ranks the publisher, lower being more reputable (Google
  News 14, CNN 165). SEO content farms sit orders of magnitude higher —
  5,143,682 for the outlet behind *"Contrasting SK hynix (SKHY) and Its
  Competitors"*, 99,999,999 for another. Anything above 2,000,000 is dropped,
  a cut set far above every genuine outlet observed (the least reputable real
  publisher in the sample sits at 1,200,410).
- **Commerce wording** that reporting does not use, matched over the headline
  *and* the description — which is where *"Start streaming DIRECTV & save up to
  $30 off"* was hiding inside an otherwise ordinary sports article. Kept
  deliberately narrow: a discount in a headline is often the news itself
  ("Government cuts rail fares by 50%"), so only retail phrasing counts.

Across a 102-article sample this dropped 11 stories, every one of them a
content farm or a retail post, with no false positives. It is not a substitute
for a flag the API does not provide: an affiliate post from a reputable outlet
with neutral wording still gets through.

newsdata.io also offers `prioritydomain=top`, which cuts the pool much harder
(6,672 results → 1,948 on a technology feed). It is not used by default because
that would thin niche topics badly, and it would not have caught the USA Today
ad anyway.

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
npm test            # 458 tests
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

- **newsdata.io free tier** is rate-limited and returns 10 articles per request,
  so each 20-item catalog page costs two API credits (cached for 10 minutes).
  The caching above is tuned to stay within it. Empty catalogs usually mean a
  spent quota or a bad key — check your newsdata.io dashboard.
- **Articles aren't video files.** Most stories open in your browser via
  Stremio's `externalUrl` stream; only stories with a `video_url` actually play.

## License

MIT
