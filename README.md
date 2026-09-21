# Newsio — a Stremio news addon

Newsio turns live headlines into Stremio catalogs: one catalog per topic you
pick, searchable from inside Stremio, with real metadata for every story and a
playable stream when the story has video.

It reads from **three news APIs**, and you can configure more than one. They
become a failover chain — when one hits its free-tier limit, Newsio moves to
the next, so your catalogs stay full instead of going empty.

**Live instance:** https://newsio.up.railway.app/configure

---

## News sources

| Source | Freshness | Per request | Video | Topics covered |
|---|---|---|---|---|
| [Currents](https://currentsapi.services) | **minutes** | 20 (a whole page, 1 credit) | no | 16 of 17 |
| [newsdata.io](https://newsdata.io) | minutes | 10 (a page costs 2 credits) | **yes** | 17 of 17 |
| [GNews](https://gnews.io) | **12 hours behind** on the free plan | 10 (a page costs 2 credits, spaced 1.5s apart) | no | 11 of 17 |

Measured, not quoted from the docs: sampled against all three at the same
moment, the newest article Currents offered was **6 minutes old** and the
newest GNews offered was **12.2 hours old**, with every article in the sample
at least that stale. GNews's free plan states the delay outright, and caps the
key at 100 requests a day.

That makes GNews a poor *primary* source for an addon whose whole pitch is live
news — but a perfectly reasonable *last resort*, which is why it is offered and
why the configure page labels it. Stale news beats an empty shelf.

Only newsdata.io carries video, so the ▶ marker only ever appears on stories it
served.

GNews also refuses two requests issued back to back — measured: the second of a
pair sent with no gap is refused outright, while the same pair a second apart
both succeed. A 20-article page is two of its responses, so Newsio spaces them
1.5 seconds apart. Without that it could not serve a full page at all. The
delay only costs anything when GNews is actually being used, which is when
every fresher source is already spent.

---

## What it does

- **Your topics become your catalogs.** Pick Technology, Finance & Business,
  World, Sports, and so on; each selected topic appears in Stremio as its own
  catalog, named after the topic.
- **One search catalog, named "Newsio".** A single catalog owns search for the
  whole addon, so a query returns one result row -- labelled **Newsio** -- that
  queries newsdata.io live across every category, rather than filtering a local
  list. The topic catalogs are browse-only.
- **Custom topics.** Anything you type becomes a catalog of its own — a saved
  search presented like any other shelf. "London crime", "Arsenal",
  "semiconductor exports". Up to 12 of them.
- **You choose the catalog order.** Topics are an ordered list, and that order
  is the order the catalogs appear in Stremio. A custom topic can sit anywhere
  among the presets.
- **A Video News catalog.** Only newsdata.io carries video, and only a small
  share of its stories have one, so browsing a normal topic surfaces them
  rarely. This catalog asks newsdata.io for video stories specifically.
- **Failover across sources.** Configure two or three keys and order them.
  Newsio tries them top to bottom and moves on whenever one is rate-limited,
  rejected or down — and remembers the failure for ten minutes so the next
  page does not begin with the same dead round trip.
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

They aren't — not on the server. Your keys, their failover order, your topics
and your language are encoded into your own addon URL as one path segment,
using the SDK's native convention:

```js
encodeURIComponent(JSON.stringify({ sources, topics, language }))

// sources is ordered — the order is the failover chain:
[{ provider: "currents", apiKey: "…" }, { provider: "newsdata", apiKey: "…" }]
```

Each provider may appear once: two keys for the same API would only fail over
into the same quota.

The deployment holds no database and no secrets. The flip side: **your install
URL contains every API key you entered, so don't share it publicly.**

## Topics and catalog order

`topics` is an **ordered list**, and the order is the setting: it is the order
the catalogs appear in Stremio. It holds two kinds of entry.

```js
topics: ["top", { q: "London crime" }, "technology"]
//        preset   custom                preset
```

A **preset** is one of the curated subjects each provider maps to its own
category vocabulary. A **custom topic** is free text, run as a standing search
and presented as a catalog of its own — "London crime" is not a category any
news API has, but it is a perfectly good saved query.

A custom topic's catalog id is derived from its text (`London crime` →
`q_london-crime`) rather than generated, so re-saving an unchanged config does
not orphan catalogs Stremio has already installed. The `q_` prefix is also what
keeps a custom topic from ever colliding with a preset id.

The id must appear in *your* config for the catalog to serve anything — another
install's catalog id means nothing here, so the addon cannot be used as an open
search proxy.

### Video News

Only newsdata.io reports video at all, and only a small share of its stories
carry one, so scrolling an ordinary topic turns up very few. The **Video News**
preset asks newsdata.io for video stories specifically (`video=1`) rather than
filtering a normal feed, so the catalog is video from end to end. The other two
sources are skipped for it — they have no video field to filter on.

The ▶ marker still only appears where playback will really work: a story whose
`video_url` is an embed page rather than a media file is left unmarked, because
Stremio can only hand that to a browser.

## Failover

`sources` in your config is an ordered list of `{ provider, apiKey }`. The
order is the setting: Newsio walks it and returns the first source that
answers.

A source is skipped before it is even tried when:

- it is **cooling off** after a recent failure (ten minutes), so one spent key
  does not cost every subsequent page a dead round trip;
- its provider **has no category for the topic** — GNews has nothing for Crime,
  so asking it would spend a request to be told so.

A source that is tried fails over when it **errors**, and when it returns an
**empty first page** — a source with nothing to say about a topic should yield
to one that has. A deeper page is left alone: there an empty result is the
honest end of the feed, and failing over would splice another source's page 1
onto this one's page 3, repeating stories the reader just scrolled past.

Only quota-shaped failures (401, 403, 409, 429, 5xx, or a message naming a rate
limit or quota) put a key on cooldown. A malformed request to one API says
nothing about the next, so the chain continues but that key is not branded as
spent.

Article ids carry a per-provider prefix — `cu_`, `nd_`, `gn_` — so a story
opened from your library is always resolved against the API that issued it,
whichever source happens to be serving catalogs at the time.

**One caveat worth knowing:** only newsdata.io can look up a single article by
id. Currents and GNews have no such endpoint, so a story from those sources is
resolvable only while it is still in the in-memory cache (one hour). Open one
from your Stremio library a day later and it will not resolve.

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
| Publisher CMS fields | `Locale: US`, `Sponsored: False`, `Content-Type: News` |

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
| `catalogCache` | 10 min | One upstream page per (provider, topic\|search, language) |
| `articleCache` | 1 hour | Individual stories by id, so `meta`/`stream` resolve without a second API call |
| `pageCursorCache` | 1 hour | newsdata.io's `nextPage` token for each page of each query |
| `sourceCooldownCache` | 10 min | Sources that just failed, so the chain skips them |

All are bounded, evicting oldest-first, so unique search queries can't grow
memory without limit. Cache keys are namespaced per provider, so two sources
answering the same topic never collide.

If an id isn't cached (expired, or the process restarted), `meta`/`stream` fall
back to a direct id lookup — but **only newsdata.io offers one**. A story from
Currents or GNews is resolvable only while it is still cached.

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
npm test            # 701 tests
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

- **Free tiers are tight.** A 20-item page costs 1 credit on Currents and 2 on
  newsdata.io or GNews. Caching is tuned to stay inside them, and configuring
  more than one source is the real answer — that is what failover is for.
  Catalogs going empty across *every* configured source usually means every
  quota is spent or every key is bad; the server logs each attempt with the
  reason it failed.
- **GNews is 12 hours behind** on its free plan, by design. Put it last.
- **Articles aren't video files.** Most stories open in your browser via
  Stremio's `externalUrl` stream; only stories with a `video_url` actually play.

## License

MIT
