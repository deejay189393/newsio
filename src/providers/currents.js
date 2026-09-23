const { realText, makeArticleId, assembleCatalogPage, sourceNameFromUrl, CATALOG_PAGE_SIZE } = require("../articles");
const { catalogCache, articleCache } = require("../cache");

const BASE_URL = "https://api.currentsapi.services/v1";
const ID_PREFIX = "cu_";

/** Currents returns 20 per response -- exactly one catalog page. */
const UPSTREAM_PAGE_SIZE = 20;

/** Canonical topic id -> the value Currents wants in `category`. */
const CATEGORIES = {
  top: "general",
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
  tourism: "travel",
  crime: null, // Currents has no equivalent; this source is skipped for it
  domestic: "regional",
  video: null // no video field in this API at all
};

const LANGUAGES = ["en", "de", "fr", "es", "it", "pt", "nl", "ru", "zh", "ar", "hi", "ja", "ko"];

/**
 * Currents' own classifier leaks its working labels into `category`.
 * "crap", "notsure" and "redundant" are verdicts about the article, not
 * subjects, and must never reach a reader's tag row.
 */
const CLASSIFIER_LABELS = new Set(["crap", "notsure", "redundant", "general", "news"]);

function normalize(raw) {
  const categories = (Array.isArray(raw.category) ? raw.category : [])
    .filter((c) => typeof c === "string")
    .filter((c) => !CLASSIFIER_LABELS.has(c.toLowerCase()));

  return {
    id: makeArticleId(ID_PREFIX, { id: raw.id, link: raw.url, title: raw.title }),
    title: realText(raw.title) || "Untitled",
    description: realText(raw.description),
    link: raw.url,
    image: raw.image && raw.image !== "None" ? raw.image : null,
    // Currents carries no video field at all.
    videoUrl: null,
    pubDate: raw.published || null,
    sourceName: sourceNameFromUrl(raw.url),
    sourceId: null,
    sourcePriority: null,
    sourceIcon: null,
    categories,
    keywords: [],
    creator: cleanAuthor(raw.author),
    provider: "currents"
  };
}

/**
 * Currents' author field concatenates every byline its scraper saw, feed
 * plumbing included: "Beth Harris, The Associated Press; Beth Harris; The
 * Associated Press; Feedloaderapi". Only the first is a person.
 */
function cleanAuthor(author) {
  const text = realText(author);
  if (!text) return null;
  const first = text.split(";")[0].trim();
  return first && first.toLowerCase() !== "feedloaderapi" ? first : null;
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
    const wrapped = new Error(`Could not reach Currents: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    /* not JSON */
  }

  // Currents answers 200 with {"status":"error"} as readily as it uses a
  // status code, so both are treated as failures.
  if (!response.ok || !body || body.status !== "ok") {
    const message = (body && (body.message || body.msg || body.error)) || "";
    const err = new Error(message || `Currents returned HTTP ${response.status}`);
    err.status = response.ok ? 429 : response.status;
    throw err;
  }
  return body;
}

const key = (queryKey, i) => `currents::${queryKey}::${i}`;

/**
 * Currents pages by a 1-based `page_number` over a stable ordering, so a
 * page can be fetched directly rather than walked to.
 */
async function fetchPage({ apiKey, topic, query, language, skip }) {
  if (!apiKey) {
    const err = new Error("Missing Currents API key");
    err.status = 401;
    throw err;
  }

  const category = query ? undefined : CATEGORIES[topic];
  if (!query && !category) {
    const err = new Error(`Currents has no category for "${topic}"`);
    err.status = 404;
    throw err;
  }

  const queryKey = JSON.stringify({ category: category || null, query: query || null, language });

  const loadPage = async (index) => {
    const cached = catalogCache.get(key(queryKey, index));
    if (cached) return cached;

    // Search is a separate endpoint; `latest-news` takes no keywords.
    const data = query
      ? await call("search", { apiKey, language, keywords: query, page_number: index + 1 })
      : await call("search", { apiKey, language, category, page_number: index + 1 });

    const articles = (Array.isArray(data.news) ? data.news : []).map(normalize);
    articles.forEach((a) => articleCache.set(a.id, a));
    const page = { articles, hasMore: articles.length === UPSTREAM_PAGE_SIZE };
    catalogCache.set(key(queryKey, index), page);
    return page;
  };

  return assembleCatalogPage({ skip, upstreamPageSize: UPSTREAM_PAGE_SIZE, loadPage });
}

/**
 * Currents exposes no single-article endpoint, so an item can only be
 * resolved from the cache populated when it was browsed. Returning null
 * lets the caller fall through to the next source rather than pretend.
 */
async function getArticleById() {
  return null;
}

module.exports = {
  id: "currents",
  label: "Currents API",
  homepage: "https://currentsapi.services",
  signupUrl: "https://currentsapi.services/en/register",
  keyPlaceholder: "your Currents API key",
  notes: "Freshest — stories arrive within minutes. 20 articles per request, so a page costs 1 credit. No video stories.",
  idPrefix: ID_PREFIX,
  supportsVideo: false,
  categories: CATEGORIES,
  languages: LANGUAGES,
  fetchPage,
  getArticleById,
  normalize,
  UPSTREAM_PAGE_SIZE,
  CATALOG_PAGE_SIZE
};
