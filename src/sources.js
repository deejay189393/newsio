const { articleCache, sourceCooldownCache } = require("./cache");
const {
  getProvider,
  isKeyOptional,
  providerSupportsTopic,
  providerSupportsLanguage,
  providerForArticleId
} = require("./providers");

/**
 * Reading a catalog from several news APIs, in the user's order, so that one
 * of them hitting its quota does not empty the shelf.
 *
 * Every provider here is on a free tier with a daily or per-minute cap, and
 * the caps are low: a newsdata.io page costs two credits against 200 a day.
 * A single source therefore runs out during ordinary use, which used to mean
 * empty catalogs with nothing in the UI to explain why.
 */

/** Errors that mean "this key is spent", as opposed to "this request was wrong". */
const QUOTA_STATUSES = new Set([401, 403, 409, 422, 429]);

function isExhausted(err) {
  if (QUOTA_STATUSES.has(err.status)) return true;
  if (typeof err.status === "number" && err.status >= 500) return true;
  return /rate limit|quota|too many requests|limit exceeded/i.test(err.message || "");
}

const cooldownKey = (providerId, apiKey) => `${providerId}::${String(apiKey).slice(-6)}`;

/**
 * The longest a quoted wait is honoured for. A limit that resets in an hour
 * should not bench a source for a day because of one odd header.
 */
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Bench a source. When the API said how long to wait -- NewsMCP's 429
 * carries the seconds until its hourly budget refills -- that is the
 * cooldown; otherwise the cache's default. A keyless source has an empty
 * key, so every keyless user shares one cooldown, which is right: they share
 * one budget.
 */
function markExhausted(source, reason, waitMs) {
  const ttl = Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, MAX_COOLDOWN_MS) : undefined;
  sourceCooldownCache.set(cooldownKey(source.provider, source.apiKey), reason || "unavailable", ttl);
}

function isOnCooldown(source) {
  return sourceCooldownCache.has(cooldownKey(source.provider, source.apiKey));
}

/**
 * Which of the configured sources could serve this request, in order.
 *
 * A source is skipped when it is cooling off after a failure, when its
 * provider has no category for the topic -- GNews has nothing for "Crime",
 * so asking it would waste a request to be told so -- or when it cannot
 * write in the reader's language.
 */
function usableSources(sources, { topic, query, language }) {
  return (sources || [])
    .map((source) => ({ source, provider: getProvider(source.provider) }))
    .filter(({ source, provider }) => {
      if (!provider) return false;
      if (!source.apiKey && !isKeyOptional(provider)) return false;
      if (!providerSupportsLanguage(provider, language)) return false;
      // A search is free text, so every provider can attempt it.
      if (!query && !providerSupportsTopic(provider, topic)) return false;
      return !isOnCooldown(source);
    });
}

/**
 * Fetch one catalog page, falling through the configured sources until one
 * answers.
 *
 * An error fails over. So does an empty *first* page: a source with nothing
 * to say about a topic should yield to one that has. Deeper pages are left
 * alone, because there an empty result is the honest end of the feed and
 * failing over would splice a second source's page 1 onto another's page 3,
 * repeating stories the reader has already scrolled past.
 */
async function fetchCatalogPage(sources, { topic, query, language, skip = 0 }) {
  const candidates = usableSources(sources, { topic, query, language });
  const attempts = [];

  for (const { source, provider } of candidates) {
    try {
      const page = await provider.fetchPage({
        apiKey: source.apiKey,
        topic,
        query,
        language,
        skip
      });

      if (skip === 0 && page.articles.length === 0 && !page.truncated) {
        attempts.push({ provider: provider.id, outcome: "empty" });
        continue;
      }
      return { ...page, provider: provider.id, attempts };
    } catch (err) {
      attempts.push({ provider: provider.id, outcome: err.message });
      if (isExhausted(err)) markExhausted(source, err.message, err.retryAfterMs);
      // A malformed request to one provider says nothing about the next, so
      // either way we keep going: the point is to return stories.
    }
  }

  if (attempts.length) {
    console.error("[sources] every source failed:", JSON.stringify(attempts));
  }
  return { articles: [], hasMore: false, truncated: false, provider: null, attempts };
}

/**
 * Resolve one article by our id, for /meta and /stream.
 *
 * The cache answers almost always, since the item was just browsed. Failing
 * that, the id's prefix says which API issued it, and only that API can be
 * asked -- another provider has never heard of the id. Currents and GNews
 * have no single-article endpoint at all, so for those the cache is the
 * only answer there is.
 */
async function getArticle(sources, id) {
  const cached = articleCache.get(id);
  if (cached) return cached;

  const provider = providerForArticleId(id);
  if (!provider) return null;

  const source = (sources || []).find((s) => s.provider === provider.id && (s.apiKey || isKeyOptional(provider)));
  if (!source) return null;

  try {
    return await provider.getArticleById(source.apiKey, id.slice(provider.idPrefix.length));
  } catch (err) {
    console.error(`[sources] ${provider.id} lookup failed:`, err.message);
    if (isExhausted(err)) markExhausted(source, err.message, err.retryAfterMs);
    return null;
  }
}

module.exports = {
  fetchCatalogPage,
  getArticle,
  usableSources,
  isExhausted,
  markExhausted,
  isOnCooldown,
  MAX_COOLDOWN_MS
};
