const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { buildInterfaceManifest, SEARCH_CATALOG_ID } = require("./manifest");
const { getTopicById, VALID_LANGUAGE_CODES } = require("./topics");
const { fetchNews, getArticleById } = require("./newsdata");
const { toMetaPreview, toFullMeta, toStreams } = require("./stremioMeta");

/**
 * Wires the real catalog/meta/stream logic into the official
 * stremio-addon-sdk builder, so request parsing (the `extra` querystring,
 * the `config` path segment, CORS, cache-control headers, resource
 * dispatch, 404/500 behaviour) is handled by the SDK's own getRouter
 * rather than a hand-rolled reimplementation of the addon protocol.
 */
/**
 * The SDK parses the config path segment as raw JSON and hands it straight
 * to the handlers, without the validation our own manifest route applies.
 * A hand-edited install URL can therefore carry anything, so normalize the
 * language here too rather than forwarding an unknown code upstream.
 */
function safeLanguage(language) {
  return typeof language === "string" && VALID_LANGUAGE_CODES.has(language) ? language : "en";
}

function createAddonInterface() {
  const builder = new addonBuilder(buildInterfaceManifest());

  // --- Catalog: a topic's headlines, or search results within that topic's
  // catalog, with skip-based pagination. Returns an empty list rather than
  // an error on upstream failure, so a rate-limited key degrades to an
  // empty shelf instead of a broken addon.
  builder.defineCatalogHandler(async ({ id, extra, config }) => {
    if (!config || !config.apiKey) return { metas: [] };

    // Two shapes of catalog reach this handler. The dedicated search
    // catalog runs a free-text query across all of newsdata.io with no
    // category filter. A topic catalog browses only its own category and
    // no longer advertises `search` at all, so a query aimed at one is
    // ignored rather than silently widened to every category.
    const isSearch = id === SEARCH_CATALOG_ID;
    const topic = isSearch ? null : getTopicById(id);
    if (!isSearch && !topic) return { metas: [] };

    const searchQuery = isSearch ? (extra && extra.search) || undefined : undefined;
    // The manifest marks this extra isRequired, but a hand-built URL can
    // still reach the search catalog with no query, and there is nothing
    // to list for one.
    if (isSearch && !searchQuery) return { metas: [] };

    const skip = parseInt((extra && extra.skip) || "0", 10) || 0;

    try {
      const { articles } = await fetchNews({
        apiKey: config.apiKey,
        category: isSearch ? undefined : topic.category,
        query: searchQuery,
        language: safeLanguage(config.language),
        skip
      });
      return { metas: articles.map(toMetaPreview), cacheMaxAge: 600 };
    } catch (err) {
      console.error("[catalog] newsdata.io error:", err.message);
      return { metas: [] };
    }
  });

  // --- Meta: full detail for one article id.
  builder.defineMetaHandler(async ({ id, config }) => {
    const article = await getArticleById(config && config.apiKey, id);
    if (!article) return Promise.reject(new Error(`Article not found: ${id}`));
    return { meta: toFullMeta(article), cacheMaxAge: 3600 };
  });

  // --- Stream: the playable video (when the story has one) plus the
  // read-the-article link.
  builder.defineStreamHandler(async ({ id, config }) => {
    const article = await getArticleById(config && config.apiKey, id);
    if (!article) return { streams: [] };
    return { streams: toStreams(article), cacheMaxAge: 3600 };
  });

  return builder.getInterface();
}

function createResourceRouter() {
  return getRouter(createAddonInterface());
}

module.exports = { createAddonInterface, createResourceRouter };
