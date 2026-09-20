const { catalogCache, articleCache, pageCursorCache } = require("./cache");

const BASE_URL = "https://newsdata.io/api/1/latest";
const PAGE_SIZE = 10; // newsdata.io returns up to 10 articles per request on the free tier
const MAX_PAGE_WALK = 5; // cap on sequential upstream calls needed to reach a deep "skip"

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

/**
 * Fetch one logical page (PAGE_SIZE articles) for a topic or search query,
 * translating Stremio's numeric `skip` into newsdata.io's opaque cursor
 * pagination.
 *
 * newsdata.io can't jump to an arbitrary offset -- each response only
 * carries the token for the *next* page. So reaching page N means having
 * fetched pages 0..N-1. We cache each page's resulting cursor as we go, so
 * the normal "scroll for more" pattern costs exactly one upstream call per
 * new page, and revisiting a page costs none. A deep, never-before-seen
 * skip is capped at MAX_PAGE_WALK sequential calls so a single request
 * can't burn the user's whole rate limit; past that we return an empty,
 * explicitly truncated page.
 */
async function fetchNews({ apiKey, category, query, language, skip = 0 }) {
  if (!apiKey) {
    const err = new Error("Missing newsdata.io API key");
    err.status = 401;
    throw err;
  }

  const pageIndex = Math.max(0, Math.floor(skip / PAGE_SIZE));
  const queryKey = JSON.stringify({
    category: category || null,
    query: query || null,
    language: language || "en"
  });

  const cachedPage = catalogCache.get(`${queryKey}::${pageIndex}`);
  if (cachedPage) return cachedPage;

  // Resume from the furthest already-known cursor rather than page 0.
  let cursor;
  let startIndex = 0;
  for (let i = pageIndex - 1; i >= 0; i--) {
    const token = pageCursorCache.get(`${queryKey}::${i}`);
    if (token !== undefined) {
      cursor = token;
      startIndex = i + 1;
      break;
    }
  }

  if (pageIndex - startIndex >= MAX_PAGE_WALK) {
    return { articles: [], hasMore: false, truncated: true };
  }

  let carriedToken = cursor;
  for (let i = startIndex; i <= pageIndex; i++) {
    if (i > startIndex && !carriedToken) {
      // Upstream ran out of pages before we reached the requested one.
      return { articles: [], hasMore: false, truncated: false };
    }

    const data = await callNewsdata({
      apikey: apiKey,
      language: language || "en",
      category: category || undefined,
      q: query || undefined,
      page: carriedToken || undefined
    });

    const articles = rememberArticles((Array.isArray(data.results) ? data.results : []).map(normalizeArticle));
    const nextPageToken = data.nextPage || null;

    pageCursorCache.set(`${queryKey}::${i}`, nextPageToken);
    catalogCache.set(`${queryKey}::${i}`, {
      articles,
      hasMore: Boolean(nextPageToken),
      truncated: false
    });

    carriedToken = nextPageToken;
  }

  return catalogCache.get(`${queryKey}::${pageIndex}`) || { articles: [], hasMore: false, truncated: false };
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

module.exports = { fetchNews, getArticleById, normalizeArticle, makeArticleId, PAGE_SIZE, MAX_PAGE_WALK };
