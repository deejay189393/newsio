const { catalogCache, articleCache, pageCursorCache } = require("./cache");

const BASE_URL = "https://newsdata.io/api/1/latest";

/**
 * newsdata.io returns at most 10 articles per request on the free tier --
 * its `size` parameter is rejected outright above that ("The size provided
 * is invalid"), so a larger catalog page has to be assembled from several
 * upstream calls rather than asked for in one.
 */
const UPSTREAM_PAGE_SIZE = 10;

/**
 * How many articles one catalog request returns to the client. Two upstream
 * pages per catalog page.
 */
const CATALOG_PAGE_SIZE = 20;

/**
 * Cap on how many upstream pages a single request may walk through to reach
 * a page it has never seen, so one deep jump cannot burn the whole daily
 * quota. Sequential scrolling never approaches this: each catalog page
 * caches its own cursor, so the next one resumes one step back.
 */
const MAX_PAGE_WALK = 12;

/**
 * Fields that newsdata.io fills with an upsell string instead of content on
 * the free tier -- `content`, `ai_summary` and friends all come back as
 * "ONLY AVAILABLE IN PAID PLANS". Treated as absent, so the placeholder can
 * never be shown to a user as if it were the article text.
 */
const PAID_PLAN_PLACEHOLDER = /^ONLY AVAILABLE IN [A-Z ]+PLANS?$/i;

/**
 * There is no ad flag in this API.
 *
 * Tested directly: newsdata.io exposes `datatype` (news / blog / review /
 * multimedia / podcast / analysis) and a `duplicate` boolean, and nothing
 * that marks sponsored or affiliate content. A plain affiliate post --
 * "Power outages happen: save up to 57% on EcoFlow power stations", USA
 * Today -- arrives as datatype "news", indistinguishable from reporting.
 * So the two deterministic signals that do exist are used instead.
 *
 * 1. `source_priority` ranks the publisher; lower is more reputable (Google
 *    News 14, CNN 165) and the SEO content farms sit orders of magnitude
 *    higher (5,143,682 for the outlet behind "Contrasting SK hynix (SKHY)
 *    and Its Competitors"; 99,999,999 for another). The cut is deliberately
 *    far above every genuine outlet observed -- Qatar Tribune, the least
 *    reputable real publisher in the sample, sits at 1,200,410.
 * 2. Commerce wording that reporting does not use. Kept narrow on purpose:
 *    a discount mentioned in a headline is news ("Government cuts rail
 *    fares by 50%"), so only retail phrasing counts.
 *
 * Neither is a substitute for a flag the API does not provide, and an
 * affiliate post from a reputable outlet still gets through.
 */
const LOW_QUALITY_SOURCE_PRIORITY = 2000000;

const COMMERCE_PHRASES = [
  /\bsave up to\b/i,
  /\b\d{1,3}% off\b/i,
  /\bbest deals?\b/i,
  /\bdeal of the (day|week)\b/i,
  /\btop deals\b/i,
  /\bcoupon(s| code)?\b/i,
  /\bshop now\b/i,
  /\bon sale now\b/i,
  /\bdiscount code\b/i,
  /\bprime day deals?\b/i,
  /\bblack friday deals?\b/i
];

/**
 * Filters what the API will not: SEO content farms, and retail posts
 * dressed as stories.
 */
function isLowQuality(article) {
  if (typeof article.sourcePriority === "number" && article.sourcePriority > LOW_QUALITY_SOURCE_PRIORITY) {
    return true;
  }
  const text = `${article.title || ""} ${article.description || ""}`;
  return COMMERCE_PHRASES.some((pattern) => pattern.test(text));
}

function realText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return !text || PAID_PLAN_PLACEHOLDER.test(text) ? "" : text;
}

/**
 * Build our Stremio-facing id for an article.
 *
 * Stability matters: Stremio stores these ids in its library/history and
 * will ask us for /meta and /stream by id long after the catalog request
 * that first surfaced the item. newsdata.io's own `article_id` is stable
 * per story, so we use it verbatim behind an "nd_" prefix (which also
 * matches the manifest's idPrefixes, so Stremio only routes these ids to
 * us). The link/title fallback is deterministic too, so the same story
 * always hashes to the same id rather than a random one.
 */
function makeArticleId(raw) {
  const source = raw.article_id || Buffer.from(raw.link || raw.title || "", "utf8").toString("base64url");
  return `nd_${source}`;
}

function normalizeArticle(raw) {
  return {
    id: makeArticleId(raw),
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
    category: Array.isArray(raw.category) ? raw.category[0] : raw.category || null,
    // The full list, not just the first: the first is usually "top".
    categories: Array.isArray(raw.category) ? raw.category.filter((c) => typeof c === "string") : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((k) => typeof k === "string") : [],
    creator: Array.isArray(raw.creator) ? raw.creator.join(", ") : realText(raw.creator) || null
  };
}

function rememberArticles(articles) {
  articles.forEach((a) => articleCache.set(a.id, a));
  return articles;
}

async function callNewsdata(params) {
  const url = new URL(BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
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
    let bodyMessage = "";
    try {
      const body = await response.json();
      bodyMessage = (body && body.results && body.results.message) || (body && body.message) || "";
    } catch (_) {
      /* body wasn't JSON -- fall through to a generic message */
    }
    const err = new Error(bodyMessage || `newsdata.io returned HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

function cacheKey(queryKey, pageIndex) {
  return `${queryKey}::${pageIndex}`;
}

/**
 * Fetch one upstream page, from cache when possible.
 *
 * The page's own `nextPage` cursor is stored alongside its articles, because
 * the two caches expire on different clocks: without it, a still-cached page
 * whose cursor had aged out could not be continued from.
 */
async function loadUpstreamPage({ apiKey, category, query, language, queryKey, pageIndex, cursor }) {
  const cached = catalogCache.get(cacheKey(queryKey, pageIndex));
  if (cached) return cached;

  const data = await callNewsdata({
    apikey: apiKey,
    language: language || "en",
    category: category || undefined,
    q: query || undefined,
    page: cursor || undefined,
    // Collapses the syndicated near-copies of one story that otherwise fill
    // a page with the same headline from six different outlets.
    removeduplicate: 1
  });

  const articles = rememberArticles((Array.isArray(data.results) ? data.results : []).map(normalizeArticle));
  const page = { articles, nextPageToken: data.nextPage || null };

  pageCursorCache.set(cacheKey(queryKey, pageIndex), page.nextPageToken);
  catalogCache.set(cacheKey(queryKey, pageIndex), page);
  return page;
}

/**
 * Fetch one catalog page for a topic or search query.
 *
 * `skip` is the addon protocol's absolute item offset -- "the number of
 * items skipped from the beginning of the catalog" -- not a page number, so
 * it is mapped onto upstream pages by arithmetic rather than assumed to
 * land on a page boundary. newsdata.io cannot jump to an offset at all:
 * each response only carries an opaque cursor for the page after it, so
 * reaching page N means having walked 0..N-1. Every page's cursor is cached
 * as it goes, which makes sequential scrolling cost only the pages actually
 * returned, and re-visiting a page cost nothing.
 */
async function fetchNews({ apiKey, category, query, language, skip = 0 }) {
  if (!apiKey) {
    const err = new Error("Missing newsdata.io API key");
    err.status = 401;
    throw err;
  }

  const offset = Math.max(0, Math.floor(Number(skip) || 0));
  const firstPage = Math.floor(offset / UPSTREAM_PAGE_SIZE);
  const offsetWithinFirstPage = offset % UPSTREAM_PAGE_SIZE;
  const pagesNeeded = Math.ceil((offsetWithinFirstPage + CATALOG_PAGE_SIZE) / UPSTREAM_PAGE_SIZE);
  const lastPage = firstPage + pagesNeeded - 1;

  const queryKey = JSON.stringify({
    category: category || null,
    query: query || null,
    language: language || "en"
  });

  // Resume from the furthest already-known cursor rather than page 0.
  let cursor;
  let startIndex = 0;
  for (let i = firstPage - 1; i >= 0; i--) {
    const token = pageCursorCache.get(cacheKey(queryKey, i));
    if (token === undefined) continue; // that page hasn't been fetched yet

    // A cached *null* means that page was the last one upstream had, so
    // every page after it is empty. Returning here matters: without it the
    // null would be carried forward as "no cursor", and the request would
    // fetch page 0 again and serve it as this page -- duplicate headlines
    // whenever the user scrolls past the end of a topic.
    if (token === null) return { articles: [], hasMore: false, truncated: false };

    cursor = token;
    startIndex = i + 1;
    break;
  }

  if (firstPage - startIndex >= MAX_PAGE_WALK) {
    return { articles: [], hasMore: false, truncated: true };
  }

  const collected = [];
  const seen = new Set();
  let carried = cursor;
  let hasMore = false;

  // The loop breaks the moment a page comes back without a cursor, so it
  // never re-enters needing one it does not have.
  for (let i = startIndex; i <= lastPage; i++) {
    const page = await loadUpstreamPage({
      apiKey,
      category,
      query,
      language,
      queryKey,
      pageIndex: i,
      cursor: carried
    });

    // Pages before firstPage are walked only to reach their cursor.
    if (i >= firstPage) {
      page.articles.forEach((article) => {
        // Upstream pages do not overlap, but a story can reappear after the
        // feed shifts under us between two calls; never emit it twice in
        // one response.
        if (seen.has(article.id)) return;
        seen.add(article.id);
        collected.push(article);
      });
    }

    carried = page.nextPageToken;
    hasMore = Boolean(carried);
    if (!carried) break;
  }

  // Sliced before filtering, deliberately: the slice positions come from
  // unfiltered upstream order, so each catalog page maps to a fixed span of
  // upstream results no matter what is dropped. Filtering first would make
  // the span drift and pages would start overlapping. The cost is that a
  // page can come back a little short, which is the right trade.
  const articles = collected
    .slice(offsetWithinFirstPage, offsetWithinFirstPage + CATALOG_PAGE_SIZE)
    .filter((article) => !isLowQuality(article));
  return { articles, hasMore: hasMore || collected.length > offsetWithinFirstPage + CATALOG_PAGE_SIZE, truncated: false };
}

/**
 * Resolve one article by our stable id -- first from the article cache
 * (populated by any earlier catalog/search fetch), then, if that has
 * expired or the item was never seen in this process, by asking
 * newsdata.io directly for that article id.
 *
 * That fallback is what makes /meta and /stream reliable for an item
 * Stremio opens from its library hours later, or after a redeploy.
 */
async function getArticleById(apiKey, id) {
  const cached = articleCache.get(id);
  if (cached) return cached;

  if (!apiKey || typeof id !== "string" || !id.startsWith("nd_")) return null;
  const upstreamId = id.slice(3);

  try {
    const data = await callNewsdata({ apikey: apiKey, id: upstreamId });
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return null;
    const [article] = rememberArticles(results.map(normalizeArticle));
    return article;
  } catch (err) {
    console.error("[newsdata] getArticleById failed:", err.message);
    return null;
  }
}

module.exports = {
  fetchNews,
  getArticleById,
  normalizeArticle,
  makeArticleId,
  realText,
  isLowQuality,
  LOW_QUALITY_SOURCE_PRIORITY,
  UPSTREAM_PAGE_SIZE,
  CATALOG_PAGE_SIZE,
  MAX_PAGE_WALK
};
