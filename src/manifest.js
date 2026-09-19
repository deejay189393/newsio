const { getTopicById } = require("./topics");

// Custom type, deliberately NOT "movie"/"series"/"channel": this keeps other
// installed metadata addons (Cinemeta, etc.) from being asked to resolve
// metadata for these ids, since they'd never recognize a "news" type anyway.
const CONTENT_TYPE = "news";

const BASE_MANIFEST = {
  id: "org.deejay189393.newsio",
  version: "1.0.0",
  name: "Newsio",
  description:
    "Live news headlines from newsdata.io, organized into catalogs by topic and searchable from inside Stremio. Powered by newsdata.io.",
  logo: "https://newsdata.io/images/logo.png",
  background: "https://newsdata.io/images/og-image.png",
  resources: ["catalog", "meta", "stream"],
  types: [CONTENT_TYPE],
  catalogs: [],
  idPrefixes: ["nd_"],
  behaviorHints: {
    configurable: true,
    configurationRequired: true
  }
};

/**
 * The manifest served with no config at all (or an invalid one) — tells
 * Stremio this addon needs to be configured before it's useful.
 */
function getUnconfiguredManifest() {
  return { ...BASE_MANIFEST, catalogs: [] };
}

/**
 * Build a full manifest for a decoded config: one catalog per selected topic.
 */
function buildManifest(config) {
  const topics = (config.topics || [])
    .map((id) => getTopicById(id))
    .filter(Boolean);

  const catalogs = topics.map((topic) => ({
    type: CONTENT_TYPE,
    id: topic.id,
    name: `News: ${topic.label}`,
    extra: [
      { name: "search" },
      { name: "skip" }
    ]
  }));

  return {
    ...BASE_MANIFEST,
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: catalogs.length === 0
    }
  };
}

module.exports = { buildManifest, getUnconfiguredManifest, CONTENT_TYPE };
