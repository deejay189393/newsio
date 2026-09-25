const { realText, makeArticleId, assembleCatalogPage, maxAgeCutoff, CATALOG_PAGE_SIZE } = require("../articles");
const { catalogCache, articleCache, pageCursorCache } = require("../cache");

const BASE_URL = "https://www.googleapis.com/youtube/v3";
const ID_PREFIX = "yt_";

/**
 * `search.list` accepts maxResults up to 50, and it is the scarcest call the
 * addon makes anywhere: a project gets 100 of them per day, full stop. So we
 * always ask for the maximum -- one search covers two and a half catalog
 * pages, and the pages in between come from cache for free.
 */
const UPSTREAM_PAGE_SIZE = 50;

/**
 * How long a fetched page is reused before YouTube is asked again.
 *
 * The shared default is ten minutes, which suits an API measured in
 * thousands of calls a day. This one is measured in a hundred: every
 * catalog on the home screen costs one search each time its page expires,
 * so seven topics at ten minutes is forty-two searches an hour and the
 * whole day's allowance inside three hours of ordinary use -- which is
 * exactly how it ran out.
 *
 * An hour instead. Results here are ordered by upload date over a query
 * that is usually a standing interest rather than a breaking story, so
 * they barely move within the hour, and it brings seven topics down to
 * well inside the daily limit even when browsed all day.
 */
const PAGE_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * A cold jump deep into a catalog has to walk the token chain from page 0,
 * and every step is one of those 100 daily searches. Four is the ceiling,
 * matching the deepest `skip` the manifest offers (180) at this page size.
 */
const MAX_PAGE_WALK = 4;

/** News & Politics. Measured: it reliably pins results to real news channels. */
const NEWS_CATEGORY = "25";

/**
 * Videos with almost no views are, in the samples taken while building this,
 * uniformly junk: auto-generated "Top 3 Tech News" reels, dead repeater
 * channels, and outright impersonators -- a channel calling itself "CNN News
 * USA" sat at 3 views next to Bloomberg's 241,766 on the same query. Genuine
 * outlets clear this within minutes of publishing; the cut is low enough not
 * to punish a small local broadcaster.
 */
const MIN_VIEW_COUNT = 500;

/** ISO 639-2 for "no linguistic content": silent footage, music beds. */
const NO_SPOKEN_LANGUAGE = "zxx";

/**
 * Canonical topic id -> the terms searched for it.
 *
 * Every entry pairs with videoCategoryId=25, which does the real work of
 * keeping results journalistic. Measured: the category holds up well for
 * broad subjects like these, but starves a narrow one -- "FIFA World Cup"
 * under it returned five thin clips in three languages -- which is why a
 * user's own topic and the search box take the other path in `fetchPage`
 * and drop the category instead.
 */
const CATEGORIES = {
  top: "top stories",
  world: "world news",
  business: "business news",
  technology: "technology news",
  science: "science news",
  health: "health news",
  sports: "sports news",
  entertainment: "entertainment news",
  politics: "politics news",
  environment: "climate and environment news",
  food: "food news",
  lifestyle: "lifestyle news",
  education: "education news",
  tourism: "travel news",
  crime: "crime news",
  domestic: "national news",
  // Every result here is a video, so the Video News catalog is simply the
  // general one. This is the only source for which that is true.
  video: "breaking news"
};

const LANGUAGES = ["en", "de", "fr", "es", "it", "pt", "nl", "ru", "zh", "ar", "hi", "ja", "ko"];

/**
 * `relevanceLanguage` is a ranking hint, not a filter -- asking for English
 * still returned Bengali and Hindi bulletins -- so a region is sent too, and
 * the hard language filter happens after enrichment. These are the largest
 * YouTube market for each language rather than any political judgement.
 */
const REGIONS = {
  en: "US", de: "DE", fr: "FR", es: "ES", it: "IT", pt: "BR", nl: "NL",
  ru: "RU", zh: "TW", ar: "AE", hi: "IN", ja: "JP", ko: "KR"
};

/** "en-IN" and "en-GB" are English; compare on the primary subtag only. */
function primaryLanguage(tag) {
  return typeof tag === "string" ? tag.toLowerCase().split("-")[0] : "";
}

/** PT1H2M3S -> seconds. Returns null for the live/unknown cases. */
function durationToSeconds(iso) {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!match) return null;
  const [, d, h, m, s] = match;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
}

function formatDuration(iso) {
  const total = durationToSeconds(iso);
  if (!total) return null;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${Math.max(1, minutes)} min`;
}

/** Pick the largest thumbnail offered. Stremio posters want the big one. */
function bestThumbnail(thumbnails) {
  const order = ["maxres", "standard", "high", "medium", "default"];
  const found = order.find((size) => thumbnails && thumbnails[size] && thumbnails[size].url);
  return found ? thumbnails[found].url : null;
}

const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

/**
 * One search hit plus its `videos.list` detail, as an article.
 *
 * The two calls are both needed. `search.list` truncates descriptions (131
 * characters against the real 736, measured on the same video) and carries
 * no duration, tags or view count; `videos.list` has all of it, accepts 50
 * ids at once and costs a single quota unit, so enrichment is effectively
 * free next to the search that found them.
 */
function normalize(item, detail) {
  const videoId = item && item.id && item.id.videoId;
  const snippet = (detail && detail.snippet) || {};
  const searchSnippet = (item && item.snippet) || {};
  const content = (detail && detail.contentDetails) || {};
  const status = (detail && detail.status) || {};
  const stats = (detail && detail.statistics) || {};

  // Field by field rather than one snippet or the other: the search result
  // is the floor, and anything the detail record happens to be missing
  // falls back to it instead of taking the whole record down with it.
  const pick = (field) => snippet[field] || searchSnippet[field];

  const views = Number(stats.viewCount);
  const language = primaryLanguage(snippet.defaultAudioLanguage || snippet.defaultLanguage);

  return {
    id: makeArticleId(ID_PREFIX, { id: videoId, link: watchUrl(videoId), title: snippet.title }),
    title: realText(pick("title")) || "Untitled",
    // Preferring the detail record here is the point of enriching at all:
    // search.list truncates this (131 characters against the real 736,
    // measured on the same video).
    description: realText(pick("description")),
    link: watchUrl(videoId),
    image: bestThumbnail(snippet.thumbnails) || bestThumbnail(searchSnippet.thumbnails),
    // The whole reason this provider exists: a bare video id is what the
    // addon protocol's `ytId` wants, and stremioMeta already turns a watch
    // URL into exactly that.
    videoUrl: watchUrl(videoId),
    pubDate: pick("publishedAt") || null,
    sourceName: realText(pick("channelTitle")) || "YouTube",
    sourceId: pick("channelId") || null,
    sourcePriority: null,
    sourceIcon: null,
    categories: [],
    keywords: Array.isArray(snippet.tags)
      ? snippet.tags.filter((t) => typeof t === "string").map((t) => realText(t)).filter(Boolean)
      : [],
    creator: null,
    duration: formatDuration(content.duration),
    viewCount: Number.isFinite(views) ? views : null,
    language,
    embeddable: status.embeddable !== false,
    liveBroadcast: pick("liveBroadcastContent") || "none",
    provider: "youtube"
  };
}

/**
 * Judge an enriched article, without removing it.
 *
 * `excluded` is honoured by the shared post-slice filter. Dropping items
 * here instead would shorten the upstream page and break the fixed-span
 * arithmetic every provider's pagination depends on, so the page keeps its
 * 50 entries and the unwanted ones are simply marked.
 */
function exclusionReason(article, wantedLanguage, { minViews = MIN_VIEW_COUNT } = {}) {
  if (!article.embeddable) return "not embeddable";
  if (article.liveBroadcast === "upcoming") return "not broadcast yet";
  // An unset language is left alone: absent is not wrong, and the major
  // outlets that omit it would otherwise be thrown away with the junk.
  // "zxx" is the same case spelled differently -- it is the ISO code for
  // "no linguistic content", so it is not a language that can fail to
  // match. Measured on an "Indian Cricket" page: three of fifty were
  // silent footage being discarded for speaking the wrong language.
  if (
    article.language &&
    article.language !== NO_SPOKEN_LANGUAGE &&
    wantedLanguage &&
    article.language !== wantedLanguage
  ) {
    return `${article.language} audio`;
  }
  if (article.viewCount !== null && article.viewCount < minViews) return "too few views";
  return null;
}

/**
 * Map Google's error vocabulary onto the status codes the failover engine
 * reads. It distinguishes three things the engine would otherwise conflate:
 * a spent daily quota (403), a per-minute burst that clears in seconds
 * (429), and a key that will never work (400 keyInvalid -- reported as 401,
 * because a 400 elsewhere means a malformed request worth retrying and this
 * one is not).
 */
function statusFor(httpStatus, reason) {
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") return 403;
  if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return 429;
  if (reason === "keyInvalid" || reason === "badRequest" || reason === "forbidden") return 401;
  return httpStatus;
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
    const wrapped = new Error(`Could not reach YouTube: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    /* not JSON */
  }

  if (!response.ok || !body || body.error) {
    const error = (body && body.error) || {};
    const detail = Array.isArray(error.errors) && error.errors.length ? error.errors[0] : {};
    const err = new Error(error.message || `YouTube returned HTTP ${response.status}`);
    err.status = statusFor(response.status, detail.reason);
    throw err;
  }
  return body;
}

/** Fill in everything `search.list` leaves out, 50 ids at a time. */
async function enrich(apiKey, items) {
  const ids = items.map((i) => i.id && i.id.videoId).filter(Boolean);
  if (!ids.length) return new Map();
  const data = await call("videos", {
    key: apiKey,
    part: "snippet,contentDetails,statistics,status",
    id: ids.join(",")
  });
  return new Map((Array.isArray(data.items) ? data.items : []).map((v) => [v.id, v]));
}

const key = (queryKey, i) => `youtube::${queryKey}::${i}`;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The reader's age limit, sent to YouTube as `publishedAfter` so the fifty
 * results a search costs are fifty that can be shown. It matters most for a
 * plain search ranked by relevance, where the best matches are often years
 * old and filtering afterwards would leave the page nearly empty.
 *
 * Rounded down to the hour: a cached page is kept for an hour, and a cutoff
 * that moved every millisecond would give every request its own cache key.
 * The hour of slack is taken back by the exact filter every source gets.
 */
function publishedAfter(maxAgeDays, now = Date.now()) {
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0) return undefined;
  const cutoff = maxAgeCutoff(maxAgeDays, now);
  return new Date(Math.floor(cutoff / HOUR_MS) * HOUR_MS).toISOString();
}

async function fetchPage({ apiKey, topic, query, language, skip, youtubeNews = true, maxAgeDays }) {
  if (!apiKey) {
    const err = new Error("Missing YouTube API key");
    err.status = 401;
    throw err;
  }

  const terms = CATEGORIES[topic];
  if (!query && !terms) {
    const err = new Error(`YouTube has no search for "${topic}"`);
    err.status = 404;
    throw err;
  }

  // A user's own topic and the search box go in as typed, with "news" added
  // and the category dropped: measured, videoCategoryId=25 strangles a
  // narrow query, and the word does the constraining instead.
  //
  // Unless the reader has switched news off, to use YouTube as a general
  // catalog. Then the query is searched as typed and ranked the way YouTube
  // ranks it: most relevant first, any length, no view floor. The news
  // tuning below exists to keep out junk bulletins, and for a film or a
  // series it would keep out the trailer and the full episodes instead.
  // The preset topics are news subjects by definition and stay as they are.
  const plain = Boolean(query) && youtubeNews === false;
  const q = query ? (plain ? query : `${query} news`) : terms;
  const category = query ? undefined : NEWS_CATEGORY;
  const wantedLanguage = primaryLanguage(language);
  const after = publishedAfter(maxAgeDays);
  const queryKey = JSON.stringify({ q, category: category || null, language, plain, after: after || null });

  const loadPage = async (index) => {
    const cached = catalogCache.get(key(queryKey, index));
    if (cached) return cached;

    let token;
    let start = 0;
    for (let i = index - 1; i >= 0; i--) {
      const stored = pageCursorCache.get(key(queryKey, i));
      if (stored === undefined) continue;
      if (stored === null) return { articles: [], hasMore: false };
      token = stored;
      start = i + 1;
      break;
    }
    if (index - start >= MAX_PAGE_WALK) return null; // too deep to reach cheaply

    let page;
    for (let i = start; i <= index; i++) {
      const data = await call("search", {
        key: apiKey,
        part: "snippet",
        type: "video",
        q,
        maxResults: UPSTREAM_PAGE_SIZE,
        // Freshest first for news, where relevance ranking returns
        // evergreen explainers months old.
        order: plain ? "relevance" : "date",
        videoCategoryId: category,
        // For news, excludes anything under four minutes, which is where
        // the Shorts and the hashtag-spam clips live.
        videoDuration: plain ? undefined : "medium",
        videoEmbeddable: "true",
        relevanceLanguage: language,
        regionCode: REGIONS[wantedLanguage],
        publishedAfter: after,
        pageToken: token || undefined
      });

      const items = Array.isArray(data.items) ? data.items : [];
      const details = await enrich(apiKey, items);
      const articles = items.map((item) => {
        const article = normalize(item, details.get(item.id && item.id.videoId));
        const reason = exclusionReason(article, wantedLanguage, { minViews: plain ? 0 : MIN_VIEW_COUNT });
        if (reason) article.excluded = reason;
        return article;
      });
      articles.filter((a) => !a.excluded).forEach((a) => articleCache.set(a.id, a));

      token = data.nextPageToken || null;
      page = { articles, hasMore: Boolean(token), nextPageToken: token };
      pageCursorCache.set(key(queryKey, i), token);
      catalogCache.set(key(queryKey, i), page, PAGE_CACHE_TTL_MS);
      if (!token && i < index) return { articles: [], hasMore: false };
    }
    return page;
  };

  return assembleCatalogPage({ skip, upstreamPageSize: UPSTREAM_PAGE_SIZE, loadPage });
}

/** One video by id, for /meta and /stream on an item no longer cached. */
async function getArticleById(apiKey, videoId) {
  const data = await call("videos", {
    key: apiKey,
    part: "snippet,contentDetails,statistics,status",
    id: videoId
  });
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) return null;
  const article = normalize({ id: { videoId } }, items[0]);
  articleCache.set(article.id, article);
  return article;
}

module.exports = {
  id: "youtube",
  label: "YouTube",
  homepage: "https://developers.google.com/youtube/v3",
  signupUrl: "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
  keyPlaceholder: "AIza...",
  notes:
    "Every story is a playable video. 100 searches a day, and results are whatever YouTube ranks -- broader topics fare better than narrow ones.",
  idPrefix: ID_PREFIX,
  supportsVideo: true,
  videoOnly: true,
  categories: CATEGORIES,
  languages: LANGUAGES,
  fetchPage,
  getArticleById,
  normalize,
  exclusionReason,
  publishedAfter,
  durationToSeconds,
  formatDuration,
  bestThumbnail,
  primaryLanguage,
  statusFor,
  UPSTREAM_PAGE_SIZE,
  MAX_PAGE_WALK,
  PAGE_CACHE_TTL_MS,
  MIN_VIEW_COUNT,
  NO_SPOKEN_LANGUAGE,
  NEWS_CATEGORY,
  REGIONS,
  CATALOG_PAGE_SIZE
};
