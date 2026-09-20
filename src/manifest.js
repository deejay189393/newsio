const { TOPICS, getTopicById } = require("./topics");

/**
 * Custom content type, deliberately NOT "movie"/"series"/"channel".
 *
 * Stremio routes a metadata request to whichever installed addon declares
 * that type + id prefix. Using our own "news" type (plus the "nd_" idPrefix
 * below) means Cinemeta and other metadata addons are never asked to
 * resolve these ids, and never overwrite our metadata with a bad match.
 */
const CONTENT_TYPE = "news";

const ADDON_ID = "org.deejay189393.newsio";
const ADDON_VERSION = "0.1.0"; // initial release
const CONTACT_EMAIL = "deejay189393@users.noreply.github.com";

/**
 * Optional listing credential for https://stremio-addons.net.
 *
 * When an addon is claimed there, the site issues a signature that must be
 * echoed back in the manifest as `stremioAddonsConfig` to prove ownership.
 * It is read from the environment rather than committed, so the public
 * repo carries no credential and claiming later needs no code change --
 * just set STREMIO_ADDONS_CONFIG_SIGNATURE (and optionally
 * STREMIO_ADDONS_CONFIG_ISSUER) on the deployment and restart.
 */
function getStremioAddonsConfig() {
  const signature = process.env.STREMIO_ADDONS_CONFIG_SIGNATURE;
  if (!signature) return undefined;
  return {
    issuer: process.env.STREMIO_ADDONS_CONFIG_ISSUER || "https://stremio-addons.net",
    signature
  };
}

/**
 * The manifest actually served to Stremio (both the bare, unconfigured one
 * and the per-user configured one).
 *
 * Deliberately has no native `config` array: we want Stremio's "Configure"
 * button to open our own rich HTML page (which `behaviorHints.configurable`
 * does on its own) rather than Stremio's bare-bones generated form.
 */
function baseManifest(baseUrl) {
  const addonsConfig = getStremioAddonsConfig();

  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: "Newsio",
    description:
      "Live news headlines from newsdata.io, organized into catalogs by topic and searchable from inside Stremio. Video stories play directly; text stories open the full article.",
    logo: `${baseUrl}/logo.png`,
    background: `${baseUrl}/background.png`,
    contactEmail: CONTACT_EMAIL,
    resources: ["catalog", "meta", "stream"],
    types: [CONTENT_TYPE],
    idPrefixes: ["nd_"],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: true
    },
    ...(addonsConfig ? { stremioAddonsConfig: addonsConfig } : {})
  };
}

/**
 * Served when there's no config in the URL: tells Stremio the addon must be
 * configured before it can be installed usefully.
 */
function getUnconfiguredManifest(baseUrl) {
  return baseManifest(baseUrl);
}

/**
 * The real per-user manifest: one catalog per selected topic, named after
 * that topic, so the user's chosen interests appear as catalog names
 * exactly as picked on the configure page.
 */
function buildManifest(config, baseUrl) {
  const topics = ((config && config.topics) || []).map(getTopicById).filter(Boolean);

  const catalogs = topics.map((topic) => ({
    type: CONTENT_TYPE,
    id: topic.id,
    name: topic.label,
    extra: [{ name: "search" }, { name: "skip" }]
  }));

  return {
    ...baseManifest(baseUrl),
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: catalogs.length === 0
    }
  };
}

/**
 * An internal-only manifest used purely to construct the
 * stremio-addon-sdk addonBuilder/router plumbing for catalog/meta/stream.
 *
 * It is never served to Stremio (buildManifest / getUnconfiguredManifest
 * above are what clients see). It exists because the SDK builds one static
 * interface at startup, and it needs:
 *   (a) every topic declared as a catalog, so the SDK's linter passes and a
 *       handler is wired for any topic id a real request might carry, and
 *   (b) a non-empty `config` array, which is what makes the SDK's
 *       getRouter() prefix its routes with the optional `/:config?` segment.
 */
function buildInterfaceManifest() {
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: "Newsio",
    description: "Internal routing manifest (not served to Stremio).",
    contactEmail: CONTACT_EMAIL,
    resources: ["catalog", "meta", "stream"],
    types: [CONTENT_TYPE],
    idPrefixes: ["nd_"],
    catalogs: TOPICS.map((topic) => ({
      type: CONTENT_TYPE,
      id: topic.id,
      name: topic.label,
      extra: [{ name: "search" }, { name: "skip" }]
    })),
    config: [{ key: "apiKey", type: "password", title: "newsdata.io API Key" }],
    behaviorHints: { configurable: true, configurationRequired: true }
  };
}

module.exports = {
  buildManifest,
  getUnconfiguredManifest,
  buildInterfaceManifest,
  getStremioAddonsConfig,
  CONTENT_TYPE,
  ADDON_ID,
  ADDON_VERSION
};
