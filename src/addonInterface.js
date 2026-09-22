const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { buildInterfaceManifest, SEARCH_CATALOG_ID } = require("./manifest");
const { VALID_LANGUAGE_CODES } = require("./providers");
const { normalizeTopics, isPresetTopicId } = require("./topics");
const { fetchCatalogPage, getArticle } = require("./sources");
const { normalizeSources } = require("./config");
const { toMetaPreview, toFullMeta, toStreams } = require("./stremioMeta");
const { currentBaseUrl } = require("./requestContext");
const { isPlaybackHealthy } = require("./youtubeHealth");

/**
 * Wires the catalog/meta/stream logic into the official stremio-addon-sdk
 * builder, so request parsing (the `extra` querystring, the `config` path
 * segment, CORS, cache-control headers, resource dispatch, 404/500
 * behaviour) is handled by the SDK's own getRouter rather than a hand-rolled
 * reimplementation of the addon protocol.
 *
 * The SDK parses the config path segment as raw JSON and hands it straight
 * to the handlers without the validation our own manifest route applies, so
 * a hand-edited install URL can carry anything. Both the language and the
 * source list are therefore normalized here too.
 */
function safeLanguage(language) {
  return typeof language === "string" && VALID_LANGUAGE_CODES.has(language) ? language : "en";
}

function safeSources(config) {
  return normalizeSources(config && config.sources);
}

function createAddonInterface() {
  const builder = new addonBuilder(buildInterfaceManifest());

  // --- Catalog: a topic's headlines, or search results, with skip-based
  // pagination, read from whichever configured source answers first.
  // Returns an empty list rather than an error on failure, so exhausted
  // keys degrade to an empty shelf instead of a broken addon.
  builder.defineCatalogHandler(async ({ id, extra, config }) => {
    const sources = safeSources(config);
    if (!sources.length) return { metas: [] };

    // Three shapes of catalog reach this handler:
    //
    //   the search catalog   free text from the user, across everything
    //   a preset topic       browses that subject's category
    //   a custom topic       a standing query the user saved, run as a
    //                        search but presented as its own catalog
    //
    // A preset topic no longer advertises `search` at all, so a query aimed
    // at one is ignored rather than silently widening the request.
    const isSearch = id === SEARCH_CATALOG_ID;
    const custom = isSearch
      ? undefined
      : normalizeTopics(config.topics).find((t) => t.kind === "custom" && t.id === id);
    if (!isSearch && !custom && !isPresetTopicId(id)) return { metas: [] };

    const searchQuery = isSearch ? (extra && extra.search) || undefined : custom ? custom.query : undefined;
    // The manifest marks that extra isRequired, but a hand-built URL can
    // still reach the search catalog with no query, and there is nothing to
    // list for one.
    if (isSearch && !searchQuery) return { metas: [] };

    const skip = parseInt((extra && extra.skip) || "0", 10) || 0;

    const { articles } = await fetchCatalogPage(sources, {
      // A custom topic is served as a search, so it carries no topic id.
      topic: isSearch || custom ? undefined : id,
      query: searchQuery,
      language: safeLanguage(config && config.language),
      skip
    });

    return { metas: articles.map(toMetaPreview), cacheMaxAge: 600 };
  });

  // --- Meta: full detail for one article id.
  builder.defineMetaHandler(async ({ id, config }) => {
    const article = await getArticle(safeSources(config), id);
    if (!article) return Promise.reject(new Error(`Article not found: ${id}`));
    return { meta: toFullMeta(article), cacheMaxAge: 3600 };
  });

  // --- Stream: the playable video (when the story has one) plus the
  // read-the-article link.
  builder.defineStreamHandler(async ({ id, config }) => {
    const article = await getArticle(safeSources(config), id);
    if (!article) return { streams: [] };
    return {
      streams: toStreams(article, {
        baseUrl: currentBaseUrl(),
        youtubeStreams: config && config.youtubeStreams,
        youtubeHealthy: isPlaybackHealthy()
      }),
      cacheMaxAge: 3600
    };
  });

  return builder.getInterface();
}

function createResourceRouter() {
  return getRouter(createAddonInterface());
}

module.exports = { createAddonInterface, createResourceRouter };
