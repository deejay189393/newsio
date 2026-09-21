const { realText, makeArticleId, assembleCatalogPage, CATALOG_PAGE_SIZE } = require("../articles");
const { catalogCache, articleCache, pageCursorCache } = require("../cache");

const BASE_URL = "https://newsdata.io/api/1/latest";
const ID_PREFIX = "nd_";

/**
 * newsdata.io returns at most 10 articles per request on the free tier --
 * its `size` parameter is rejected outright above that -- so a catalog page
 * is assembled from two upstream calls.
 */
const UPSTREAM_PAGE_SIZE = 10;

/**
 * Cap on how many pages a single request may walk to reach one it has never
 * seen, so a deep jump cannot burn the daily quota. Sequential scrolling
 * never approaches it: each page caches its cursor, so the next resumes one
 * step back.
 */
const MAX_PAGE_WALK = 12;

/** Canonical topic id -> the value newsdata.io wants in `category`. */
const CATEGORIES = {
  top: "top",
  world: "world",
  business: "business",
  technology: "technology",
  science: "science",
  health: "health",
  sports: "sports",
  entertainment: "entertainment",
  politics: "politics",
  environment: "environment",
  food: "food",
  lifestyle: "lifestyle",
  education: "education",
  tourism: "tourism",
  crime: "crime",
  domestic: "domestic",
  // Not a category: a filter across all news for stories that carry a
  // playable video. newsdata.io is the only source that has one.
  video: { video: 1 }
};

const LANGUAGES = ["en", "de", "fr", "es", "it", "pt", "nl", "ru", "zh", "ar", "hi", "ja", "ko"];

function normalize(raw) {
  return {
    id: makeArticleId(ID_PREFIX, { id: raw.article_id, link: raw.link, title: raw.title }),
    title: realText(raw.title) || "Untitled",
    description: realText(raw.description) || realText(raw.content),
    link: raw.link,
    image: raw.image_url || null,
    videoUrl: raw.video_url || null,
    pubDate: raw.pubDate || null,
    sourceName: realText(raw.source_name) || realText(raw.source_id) || "Unknown source",
    sourceId: realText(raw.source_id) || null,
    sourcePriority: typeof raw.source_priority === "number" ? raw.source_priority : null,
    sourceIcon: raw.source_icon || null,
    categories: Array.isArray(raw.category) ? raw.category.filter((c) => typeof c === "string") : [],
    keywords: Array.isArray(raw.keywords)
      ? raw.keywords.filter((k) => typeof k === "string").map((k) => realText(k)).filter(Boolean)
      : [],
    creator: Array.isArray(raw.creator) ? raw.creator.join(", ") : realText(raw.creator) || null,
    provider: "newsdata"
  };
}

async function call(params) {
  const url = new URL(BASE_URL);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  let response;
  try {
    response = await fetch(url.toString());
  } catch (err) {
    const wrapped = new Error(`Could not reach newsdata.io: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  if (!response.ok) {
    let message = "";
    try {
      const body = await response.json();
      message = (body && body.results && body.results.message) || (body && body.message) || "";
    } catch (_) {
      /* not JSON -- fall through to a generic message */
    }
    const err = new Error(message || `newsdata.io returned HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

const key = (queryKey, i) => `newsdata::${queryKey}::${i}`;

/**
 * newsdata.io pages with an opaque `nextPage` cursor rather than a page
 * number, so reaching page N means having walked 0..N-1. Each page's cursor
 * is cached alongside its articles -- the two caches expire on different
 * clocks, so a still-cached page whose cursor had aged out could not
 * otherwise be continued from.
 */
async function fetchPage({ apiKey, topic, query, language, skip }) {
  if (!apiKey) {
    const err = new Error("Missing newsdata.io API key");
    err.status = 401;
    throw err;
  }

  const mapping = query ? undefined : CATEGORIES[topic];
  const category = typeof mapping === "string" ? mapping : undefined;
  // A mapping that is an object contributes extra query parameters instead
  // of a category -- `video: 1` for the Video News catalog.
  const filters = mapping && typeof mapping === "object" ? mapping : {};
  const queryKey = JSON.stringify({ category: category || null, filters, query: query || null, language });

  const loadPage = async (index) => {
    const cached = catalogCache.get(key(queryKey, index));
    if (cached) return cached;

    // Walk forward from the furthest cursor already known.
    let cursor;
    let start = 0;
    for (let i = index - 1; i >= 0; i--) {
      const token = pageCursorCache.get(key(queryKey, i));
      if (token === undefined) continue;
      // A cached null means that page was upstream's last, so everything
      // after it is empty -- without this the null would be carried forward
      // as "no cursor" and page 0 would be refetched and served again.
      if (token === null) return { articles: [], hasMore: false };
      cursor = token;
      start = i + 1;
      break;
    }
    if (index - start >= MAX_PAGE_WALK) return null; // too deep to reach cheaply

    // Nothing in [start, index] can be cached: the scan above stopped at the
    // highest cached cursor below `index`, a cached page always implies a
    // cached cursor, and `index` itself was checked on the way in.
    let page;
    for (let i = start; i <= index; i++) {
      const data = await call({
        apikey: apiKey,
        language,
        category,
        ...filters,
        q: query || undefined,
        page: cursor || undefined,
        // Collapses the syndicated near-copies that otherwise fill a page
        // with the same headline from six different outlets.
        removeduplicate: 1
      });
      const articles = (Array.isArray(data.results) ? data.results : []).map(normalize);
      articles.forEach((a) => articleCache.set(a.id, a));
      cursor = data.nextPage || null;
      page = { articles, hasMore: Boolean(cursor), nextPageToken: cursor };
      pageCursorCache.set(key(queryKey, i), cursor);
      catalogCache.set(key(queryKey, i), page);
      if (!cursor && i < index) return { articles: [], hasMore: false };
    }
    return page;
  };

  return assembleCatalogPage({ skip, upstreamPageSize: UPSTREAM_PAGE_SIZE, loadPage });
}

/** newsdata.io can resolve a single article by id, which /meta relies on. */
async function getArticleById(apiKey, upstreamId) {
  const data = await call({ apikey: apiKey, id: upstreamId });
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return null;
  const article = normalize(results[0]);
  articleCache.set(article.id, article);
  return article;
}

module.exports = {
  id: "newsdata",
  label: "newsdata.io",
  homepage: "https://newsdata.io",
  signupUrl: "https://newsdata.io/register",
  keyPlaceholder: "pub_xxxxxxxxxxxxxxxxxxxx",
  // Shown on the configure page so the trade-offs are visible where the
  // choice is actually made.
  notes: "Live. 10 articles per request, so a page costs 2 credits. Supports video stories.",
  idPrefix: ID_PREFIX,
  supportsVideo: true,
  categories: CATEGORIES,
  languages: LANGUAGES,
  fetchPage,
  getArticleById,
  normalize,
  UPSTREAM_PAGE_SIZE,
  MAX_PAGE_WALK,
  CATALOG_PAGE_SIZE
};
