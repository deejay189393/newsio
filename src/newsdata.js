const BASE_URL = "https://newsdata.io/api/1/latest";

// Very small in-memory cache to stay well within newsdata.io's rate limits.
// Keyed by the full request (topic + query + language + page).
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

// Cache of individual articles, populated whenever a catalog request runs,
// so that /meta and /stream lookups (which only receive an id) can find the
// full article again without another API call.
const articleCache = new Map();
const ARTICLE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

function rememberArticle(article) {
  articleCache.set(article.id, { article, expires: Date.now() + ARTICLE_CACHE_TTL_MS });
}

function getRememberedArticle(id) {
  const hit = articleCache.get(id);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    articleCache.delete(id);
    return null;
  }
  return hit.article;
}

function makeArticleId(raw) {
  // newsdata.io's article_id is already unique & url-safe enough for our use.
  return `nd_${raw}`;
}

function normalizeArticle(raw) {
  const id = makeArticleId(raw.article_id || Buffer.from(raw.link || raw.title).toString("base64url"));
  return {
    id,
    title: raw.title || "Untitled",
    description: raw.description || raw.content || "",
    link: raw.link,
    image: raw.image_url || null,
    videoUrl: raw.video_url || null,
    pubDate: raw.pubDate || null,
    sourceName: raw.source_name || raw.source_id || "Unknown source",
    sourceIcon: raw.source_icon || null,
    category: Array.isArray(raw.category) ? raw.category[0] : raw.category || null,
    creator: Array.isArray(raw.creator) ? raw.creator.join(", ") : raw.creator || null
  };
}

/**
 * Fetch a page of news for a given topic (or a free-text search query).
 * Throws an Error with a `.status` property on HTTP-level failures so
 * callers can translate that into a sensible Stremio-facing response.
 */
async function fetchNews({ apiKey, category, query, language, page }) {
  if (!apiKey) {
    const err = new Error("Missing newsdata.io API key");
    err.status = 401;
    throw err;
  }

  const cacheKey = JSON.stringify({ category: category || null, query: query || null, language, page: page || null });
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = new URL(BASE_URL);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("language", language || "en");
  if (category && category !== "top") {
    url.searchParams.set("category", category);
  } else if (category === "top") {
    url.searchParams.set("category", "top");
  }
  if (query) url.searchParams.set("q", query);
  if (page) url.searchParams.set("page", page);

  let response;
  try {
    response = await fetch(url.toString());
  } catch (err) {
    const wrapped = new Error(`Could not reach newsdata.io: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  if (!response.ok) {
    let bodyMessage = "";
    try {
      const body = await response.json();
      bodyMessage = body?.results?.message || body?.message || "";
    } catch (_) {
      /* ignore body parse errors */
    }
    const err = new Error(bodyMessage || `newsdata.io returned HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const articles = results.map(normalizeArticle);
  articles.forEach(rememberArticle);

  const value = { articles, nextPage: data.nextPage || null };
  cacheSet(cacheKey, value);
  return value;
}

module.exports = { fetchNews, getRememberedArticle };
