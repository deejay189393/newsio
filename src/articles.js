/**
 * The article shape every provider normalizes to, and the text handling that
 * is the same whoever supplied the story.
 *
 * Providers differ in their pagination, their category vocabulary and their
 * field names; none of that belongs here. What does belong here is the
 * contract the rest of the addon codes against.
 */

/** How many articles one catalog request returns to the client. */
const CATALOG_PAGE_SIZE = 20;

/**
 * Fields an API fills with an upsell string rather than content on a free
 * tier -- newsdata.io returns "ONLY AVAILABLE IN PAID PLANS" for `content`,
 * `ai_summary` and others. Treated as absent so a placeholder can never be
 * shown to a reader as if it were the article.
 */
const PAID_PLAN_PLACEHOLDER = /^ONLY AVAILABLE IN [A-Z ]+PLANS?$/i;

/**
 * Publishers hand these APIs HTML-escaped text and it is passed through
 * verbatim, so a keyword arrives as "telco &amp; isp" and renders with the
 * entity showing. Everything downstream is JSON for Stremio rather than
 * markup, so text is decoded once, at the boundary.
 */
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function realText(value) {
  const text = typeof value === "string" ? decodeEntities(value).trim() : "";
  return !text || PAID_PLAN_PLACEHOLDER.test(text) ? "" : text;
}

/**
 * Our Stremio-facing id for an article.
 *
 * Stability matters: Stremio stores these in its library and asks for /meta
 * and /stream by id long after the catalog request that surfaced the item.
 * The provider's own id is used verbatim behind a per-provider prefix, which
 * is also what lets a later lookup know which API to ask. The link/title
 * fallback is deterministic, so the same story always yields the same id.
 */
function makeArticleId(prefix, { id, link, title }) {
  const source = id || Buffer.from(link || title || "", "utf8").toString("base64url");
  return `${prefix}${source}`;
}

/**
 * A publisher name taken from an article's host, for APIs that name none --
 * "www.winnipegfreepress.com" reads as "Winnipegfreepress". Better than
 * "Unknown source" on every single item, which is what the field would
 * otherwise show. Currents and NewsMCP both need it.
 *
 * The name is the label just before the public suffix, with a two-part
 * country suffix ("co.kr", "com.ar") counted as one: "en.yna.co.kr" is Yna,
 * not En. Taking the host's first label instead -- as this once did -- named
 * Yonhap "En", Yahoo "Sports" and CNN "Edition". A label left of it still
 * wins when it is a name rather than an edition or a language, since some
 * brands live on a parent's domain: "timesofindia.indiatimes.com".
 */
const SECOND_LEVEL_LABELS = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ne", "or", "go", "gob", "mil", "nic"]);
const EDITION_LABELS = new Set([
  "www", "www2", "www3", "m", "mobile", "amp", "en", "eng", "english",
  "edition", "news", "sport", "sports", "world", "international"
]);

function sourceNameFromUrl(url) {
  let labels;
  try {
    labels = new URL(url).hostname.split(".");
  } catch (_) {
    return "Unknown source";
  }
  const last = labels.length - 1;
  const twoPartSuffix = labels.length > 2 && labels[last].length === 2 && SECOND_LEVEL_LABELS.has(labels[last - 1]);
  const registrable = Math.max(0, labels.length - (twoPartSuffix ? 3 : 2));
  const name = labels.slice(0, registrable).find((label) => !EDITION_LABELS.has(label)) || labels[registrable];
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Unknown source";
}

/**
 * Neither newsdata.io nor Currents flags advertising. Tested directly: they
 * expose content-type fields and duplicate flags, and nothing marking
 * sponsored or affiliate content -- a plain affiliate post ("Power outages
 * happen: save up to 57% on EcoFlow power stations", USA Today) arrives as
 * ordinary news. So the signals that do exist are used instead.
 *
 * `source_priority` (newsdata only) ranks the publisher, lower being more
 * reputable: Google News 14, CNN 165, while SEO content farms sit orders of
 * magnitude higher. The cut is deliberately far above every genuine outlet
 * observed -- the least reputable real publisher in the sample was 1,200,410.
 */
const LOW_QUALITY_SOURCE_PRIORITY = 2000000;

/**
 * Commerce wording that reporting does not use. Kept narrow on purpose: a
 * discount in a headline is often the news itself ("Government cuts rail
 * fares by 50%"), so only retail phrasing counts.
 */
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

function isLowQuality(article) {
  // A provider may have already judged the item while it had detail the
  // shared rules never see -- YouTube knows a video's spoken language, view
  // count and whether it is embeddable at all. Marking rather than dropping
  // is deliberate: it keeps the upstream page its full size, which the
  // slice arithmetic below depends on.
  if (article.excluded) return true;
  if (typeof article.sourcePriority === "number" && article.sourcePriority > LOW_QUALITY_SOURCE_PRIORITY) {
    return true;
  }
  const text = `${article.title || ""} ${article.description || ""}`;
  return COMMERCE_PHRASES.some((pattern) => pattern.test(text));
}

/**
 * Assemble one catalog page from fixed-size upstream pages.
 *
 * `skip` is the addon protocol's absolute item offset -- "the number of
 * items skipped from the beginning of the catalog" -- not a page number, so
 * it is mapped onto upstream pages by arithmetic rather than assumed to land
 * on a boundary. `loadPage(index)` returns { articles, hasMore } for one
 * upstream page; the caller decides how that page is fetched.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function assembleCatalogPage({
  skip,
  upstreamPageSize,
  loadPage,
  // Some APIs reject two requests issued back to back. GNews does: a page
  // built from two of its 10-article responses is blocked on the second
  // every time unless they are spaced out, which would make it unable to
  // serve a full page at all. `delay` is a seam for tests; nothing else
  // passes it.
  interPageDelayMs = 0,
  delay = sleep
}) {
  const offset = Math.max(0, Math.floor(Number(skip) || 0));
  const firstPage = Math.floor(offset / upstreamPageSize);
  const offsetWithinFirstPage = offset % upstreamPageSize;
  const pagesNeeded = Math.ceil((offsetWithinFirstPage + CATALOG_PAGE_SIZE) / upstreamPageSize);

  const collected = [];
  const seen = new Set();
  let hasMore = false;

  for (let i = firstPage; i < firstPage + pagesNeeded; i++) {
    if (i > firstPage && interPageDelayMs) await delay(interPageDelayMs);
    const page = await loadPage(i);
    if (!page) return { articles: [], hasMore: false, truncated: true };

    page.articles.forEach((article) => {
      // Upstream pages should not overlap, but a story can reappear after
      // the feed shifts between two calls; never emit it twice.
      if (seen.has(article.id)) return;
      seen.add(article.id);
      collected.push(article);
    });

    hasMore = Boolean(page.hasMore);
    if (!page.hasMore) break;
  }

  // Sliced before filtering, deliberately: the slice positions come from
  // unfiltered upstream order, so each catalog page maps to a fixed span of
  // upstream results no matter what is dropped. Filtering first would make
  // the span drift and pages would start overlapping.
  const articles = collected
    .slice(offsetWithinFirstPage, offsetWithinFirstPage + CATALOG_PAGE_SIZE)
    .filter((article) => !isLowQuality(article));

  return { articles, hasMore, truncated: false };
}

module.exports = {
  CATALOG_PAGE_SIZE,
  decodeEntities,
  realText,
  makeArticleId,
  sourceNameFromUrl,
  isLowQuality,
  assembleCatalogPage,
  LOW_QUALITY_SOURCE_PRIORITY
};
