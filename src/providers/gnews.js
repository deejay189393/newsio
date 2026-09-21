const { realText, makeArticleId, assembleCatalogPage, CATALOG_PAGE_SIZE } = require("../articles");
const { catalogCache, articleCache } = require("../cache");

const BASE_URL = "https://gnews.io/api/v4";
const ID_PREFIX = "gn_";

/** GNews caps a free-tier response at 10 regardless of `max`. */
const UPSTREAM_PAGE_SIZE = 10;

/**
 * GNews blocks two requests issued back to back -- measured: the second of a
 * pair sent with no gap is refused ("blocked because you made too many
 * requests in a short period"), while the same pair a second apart both
 * succeed. A 20-article page is two of its responses, so without spacing
 * them it could never serve a full page. 1.5s buys margin over the measured
 * threshold; it only costs anything when GNews is actually being used, which
 * is when every fresher source is already spent.
 */
const INTER_PAGE_DELAY_MS = 1500;

/** Canonical topic id -> the value GNews wants in `category`. */
const CATEGORIES = {
  top: "general",
  world: "world",
  business: "business",
  technology: "technology",
  science: "science",
  health: "health",
  sports: "sports",
  entertainment: "entertainment",
  politics: "nation",
  environment: null,
  food: null,
  lifestyle: null,
  education: null,
  tourism: null,
  crime: null,
  domestic: "nation",
  other: "general"
};

const LANGUAGES = ["en", "de", "fr", "es", "it", "pt", "nl", "ru", "zh", "ar", "hi", "ja", "ko"];

function normalize(raw) {
  return {
    id: makeArticleId(ID_PREFIX, { id: raw.id, link: raw.url, title: raw.title }),
    title: realText(raw.title) || "Untitled",
    description: realText(raw.description) || realText(raw.content),
    link: raw.url,
    image: raw.image || null,
    videoUrl: null,
    pubDate: raw.publishedAt || null,
    sourceName: realText(raw.source && raw.source.name) || "Unknown source",
    sourceId: (raw.source && raw.source.id) || null,
    sourcePriority: null,
    sourceIcon: null,
    categories: [],
    keywords: [],
    creator: null,
    provider: "gnews"
  };
}

async function call(path, params) {
  const url = new URL(`${BASE_URL}/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  let response;
  try {
    response = await fetch(url.toString());
  } catch (err) {
    const wrapped = new Error(`Could not reach GNews: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    /* not JSON */
  }

  if (!response.ok || !body || body.errors) {
    const message = body && Array.isArray(body.errors) ? body.errors.join("; ") : "";
    const err = new Error(message || `GNews returned HTTP ${response.status}`);
    err.status = response.status === 200 ? 429 : response.status;
    throw err;
  }
  return body;
}

const key = (queryKey, i) => `gnews::${queryKey}::${i}`;

async function fetchPage({ apiKey, topic, query, language, skip, delay }) {
  if (!apiKey) {
    const err = new Error("Missing GNews API key");
    err.status = 401;
    throw err;
  }

  const category = query ? undefined : CATEGORIES[topic];
  if (!query && !category) {
    const err = new Error(`GNews has no category for "${topic}"`);
    err.status = 404;
    throw err;
  }

  const queryKey = JSON.stringify({ category: category || null, query: query || null, language });

  const loadPage = async (index) => {
    const cached = catalogCache.get(key(queryKey, index));
    if (cached) return cached;

    const data = query
      ? await call("search", { apikey: apiKey, lang: language, q: query, page: index + 1 })
      : await call("top-headlines", { apikey: apiKey, lang: language, category, page: index + 1 });

    const articles = (Array.isArray(data.articles) ? data.articles : []).map(normalize);
    articles.forEach((a) => articleCache.set(a.id, a));
    const page = { articles, hasMore: articles.length === UPSTREAM_PAGE_SIZE };
    catalogCache.set(key(queryKey, index), page);
    return page;
  };

  return assembleCatalogPage({
    skip,
    upstreamPageSize: UPSTREAM_PAGE_SIZE,
    loadPage,
    interPageDelayMs: INTER_PAGE_DELAY_MS,
    ...(delay ? { delay } : {})
  });
}

/** GNews exposes no single-article endpoint. */
async function getArticleById() {
  return null;
}

module.exports = {
  id: "gnews",
  label: "GNews",
  homepage: "https://gnews.io",
  signupUrl: "https://gnews.io/register",
  keyPlaceholder: "your GNews API key",
  notes:
    "Last resort only — the free plan delays every article by 12 hours, and allows 100 requests a day. No video stories.",
  idPrefix: ID_PREFIX,
  supportsVideo: false,
  delayed: true,
  categories: CATEGORIES,
  languages: LANGUAGES,
  fetchPage,
  getArticleById,
  normalize,
  UPSTREAM_PAGE_SIZE,
  INTER_PAGE_DELAY_MS,
  CATALOG_PAGE_SIZE
};
