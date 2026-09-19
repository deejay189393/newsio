# Newsio — a Stremio News Addon

A Stremio addon that turns live headlines from [newsdata.io](https://newsdata.io) into
Stremio catalogs — one catalog per topic you pick (Technology, Finance & Business,
World, Sports, etc.) — and makes them searchable from inside Stremio.

Each item is real metadata (title, description, poster, backdrop), not a generic
link. Articles use a custom Stremio content type, `news`, on purpose: other
installed metadata addons (Cinemeta and similar) only resolve `movie`/`series`
ids, so they'll never try to hijack or overwrite Newsio's own news metadata.

- If a story has an actual video attached (newsdata.io's `video_url`), its
  description is prefixed with **`[VIDEO]`** and pressing play opens that video.
- Every story also offers a "read the full article" stream, since not every
  story has a video.

Each user's own newsdata.io API key and chosen topics are encoded right into their
personal addon URL. Nothing is stored server-side — the deployment itself has no
database and holds no secrets.

## How it works

- `GET /configure` — a web page where you paste your newsdata.io API key and check
  off the topics you want. It generates your personal install URL.
- `GET /:config/manifest.json` — the manifest Stremio reads, with one `news`-type
  catalog per selected topic, `config` being your API key + topics, base64url-encoded.
- `GET /:config/catalog/news/:topic/:extra?.json` — headlines for a topic. Also
  handles Stremio's search box via the `search` extra property.
- `GET /:config/meta/news/:id.json` — full detail view for one article: title,
  description (with the `[VIDEO]` tag when relevant), poster, backdrop, genre,
  source link.
- `GET /:config/stream/news/:id.json` — returns the video stream (if the article
  has one) and/or an `externalUrl` stream that opens the article in a browser.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000/configure` in a browser, fill in your API key and
topics, and click "Install in Stremio" (or copy the generated manifest URL and paste
it into Stremio's *Search / "Addon Repository URL"* box).

## Deploy to Railway

1. Push this repo to GitHub (see below).
2. In [Railway](https://railway.com), choose **New Project → Deploy from GitHub repo**
   and select this repository. Railway will detect the `Dockerfile` and build it
   automatically — no environment variables are required.
3. Once deployed, open `https://<your-railway-domain>/configure` to generate your
   install link.

Railway assigns the `PORT` environment variable automatically; the server already
reads it (`process.env.PORT`).

## Push to GitHub

```bash
cd stremio-newsdata-addon
git init
git add .
git commit -m "Initial commit: Newsio Stremio addon"
git branch -M main
git remote add origin https://github.com/deejay189393/stremio-newsdata-addon.git
git push -u origin main
```

(Create the empty repo first at https://github.com/new — name it
`stremio-newsdata-addon`, or whatever you prefer, under your account.)

## Notes & caveats

- **Custom `news` type**: this is deliberate (see above), but it does mean Stremio's
  dedicated Movies/Series tabs won't show these catalogs — they'll appear on the
  Board/Discover screen and in search results, same as other non-movie/series
  addons (e.g. live TV addons using the `channel` type).
- **newsdata.io free-tier limits**: the free plan is rate-limited (a small number
  of requests per day/15 minutes, 10 articles per request). The addon caches each
  topic/search query for 10 minutes in memory to help stay within that budget.
  If you see empty catalogs, check your newsdata.io dashboard for quota/key issues.
- **In-memory cache**: article details (needed for the "meta" and "stream" clicks)
  are cached in memory for 1 hour. On a fresh deploy/restart, very old links may
  need to be re-browsed from the catalog before they're clickable again.
- **No secrets on the server**: your API key lives only in your personal addon URL.
  Don't share that URL publicly, since it contains your key.
