const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { buildInterfaceManifest } = require("./manifest");
const { getTopicById } = require("./topics");
const { fetchNews, getArticleById } = require("./newsdata");
const { toMetaPreview, toFullMeta, toStreams } = require("./stremioMeta");

/**
 * Wires the real catalog/meta/stream logic into the official
 * stremio-addon-sdk builder, so request parsing (the `extra` querystring,
 * the `config` path segment, CORS, cache-control headers, resource
 * dispatch, 404/500 behaviour) is handled by the SDK's own getRouter
 * rather than a hand-rolled reimplementation of the addon protocol.
 */
function createAddonInterface() {
  const builder = new addonBuilder(buildInterfaceManifest());

  // --- Catalog: a topic's headlines, or search results within that topic's
  // catalog, with skip-based pagination. Returns an empty list rather than
  // an error on upstream failure, so a rate-limited key degrades to an
  // empty shelf instead of a broken addon.
  builder.defineCatalogHandler(async ({ id, extra, config }) => {
    const topic = getTopicById(id);
    if (!topic || !config || !config.apiKey) return { metas: [] };

    const searchQuery = (extra && extra.search) || undefined;
    const skip = parseInt((extra && extra.skip) || "0", 10) || 0;

    try {
      const { articles } = await fetchNews({
        apiKey: config.apiKey,
        // A search is a free-text query across all news, so the topic's
        // category filter is dropped while searching.
        category: searchQuery ? undefined : topic.category,
        query: searchQuery,
        language: config.language,
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
