const express = require("express");
const { encodeConfig, decodeConfig } = require("./src/config");
const { buildManifest, getUnconfiguredManifest } = require("./src/manifest");
const { getTopicById } = require("./src/topics");
const { fetchNews, getRememberedArticle } = require("./src/newsdata");
const { toMetaPreview, toFullMeta, toStreams } = require("./src/stremioMeta");
const { renderConfigurePage } = require("./src/configurePage");

const app = express();
const PORT = process.env.PORT || 3000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*"
};

app.use((req, res, next) => {
  res.set(CORS_HEADERS);
  next();
});

function getBaseUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto");
  const proto = forwardedProto ? forwardedProto.split(",")[0] : req.protocol;
  return `${proto}://${req.get("host")}`;
}

// ---------------------------------------------------------------------------
// Root & configure (no config yet)
// ---------------------------------------------------------------------------

app.get("/", (req, res) => res.redirect("/configure"));

app.get("/configure", (req, res) => {
  res.set("Content-Type", "text/html");
  res.send(renderConfigurePage({ baseUrl: getBaseUrl(req), existing: null }));
});

// Bare manifest (no config segment) — tells Stremio it needs configuring.
app.get("/manifest.json", (req, res) => {
  res.json(getUnconfiguredManifest());
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Configured routes: /:config/...
// ---------------------------------------------------------------------------

function requireConfig(req, res, next) {
  const decoded = decodeConfig(req.params.config);
  if (!decoded) {
    return res.status(400).json({ error: "Invalid or missing addon configuration." });
  }
  req.addonConfig = decoded;
  next();
}

app.get("/:config/configure", requireConfig, (req, res) => {
  res.set("Content-Type", "text/html");
  res.send(renderConfigurePage({ baseUrl: getBaseUrl(req), existing: req.addonConfig }));
});

app.get("/:config/manifest.json", requireConfig, (req, res) => {
  res.json(buildManifest(req.addonConfig));
});

// Stremio encodes "extra" catalog properties (search, skip, ...) as a single
// path segment, e.g. /catalog/news/technology/search=ai%20chips.json
// or /catalog/news/technology/skip=20.json (both may be joined by "&").
function parseExtra(segment) {
  const out = {};
  if (!segment) return out;
  const withoutExt = segment.replace(/\.json$/, "");
  withoutExt.split("&").forEach((pair) => {
    const [key, ...rest] = pair.split("=");
    if (!key) return;
    out[decodeURIComponent(key)] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

app.get("/:config/catalog/:type/:id/:extra?.json", requireConfig, async (req, res) => {
  const { id, extra: extraSegment } = req.params;
  const topic = getTopicById(id);
  if (!topic) return res.json({ metas: [] });

  const extra = parseExtra(extraSegment);
  const searchQuery = extra.search || undefined;
  const skip = parseInt(extra.skip, 10) || 0;
  const page = skip > 0 ? String(skip) : undefined;

  try {
    const { articles } = await fetchNews({
      apiKey: req.addonConfig.apiKey,
      category: searchQuery ? undefined : topic.category,
      query: searchQuery,
      language: req.addonConfig.language,
      page
    });
    res.json({ metas: articles.map(toMetaPreview) });
  } catch (err) {
    console.error("[catalog] newsdata.io error:", err.message);
    res.json({ metas: [] });
  }
});

app.get("/:config/meta/:type/:id.json", requireConfig, (req, res) => {
  const article = getRememberedArticle(req.params.id);
  if (!article) return res.status(404).json({ error: "Article not found (cache expired)." });
  res.json({ meta: toFullMeta(article) });
});

app.get("/:config/stream/:type/:id.json", requireConfig, (req, res) => {
  const article = getRememberedArticle(req.params.id);
  if (!article) return res.json({ streams: [] });
  res.json({ streams: toStreams(article) });
});

app.listen(PORT, () => {
  console.log(`newsdata.io Stremio addon listening on port ${PORT}`);
});
