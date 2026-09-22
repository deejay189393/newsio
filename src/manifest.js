const { TOPICS, PROVIDERS } = require("./providers");
const { normalizeTopics } = require("./topics");
const { CATALOG_PAGE_SIZE } = require("./articles");
const { isConfigured } = require("./config");

/**
 * Custom content type, deliberately NOT "movie"/"series"/"channel".
 *
 * Stremio routes a metadata request to whichever installed addon declares
 * that type + id prefix. Using our own "news" type (plus the "nd_" idPrefix
 * below) means Cinemeta and other metadata addons are never asked to
 * resolve these ids, and never overwrite our metadata with a bad match.
 */
const CONTENT_TYPE = "news";

/**
 * One prefix per provider, so Stremio routes every id we mint back to us and
 * a later /meta lookup can tell which API issued it.
 */
const ID_PREFIXES = PROVIDERS.map((p) => p.idPrefix);

const ADDON_ID = "org.deejay189393.newsio";
const ADDON_VERSION = "0.12.1";
const CONTACT_EMAIL = "deejay189393@users.noreply.github.com";
const DESCRIPTION =
  "News on Stremio? Why not! Reads live headlines from newsdata.io, Currents, YouTube and GNews.";

/**
 * Search is served by ONE catalog for the whole addon, not by every topic.
 *
 * A catalog that declares `search` in its `extra` becomes a separate row in
 * the client's search results, so declaring it on each topic meant one
 * identical result row per selected topic ("Top Stories - News",
 * "Technology - News", ...) all running the same free-text query. Instead
 * the topic catalogs are browse-only and this single catalog owns search,
 * which is why it is named for the addon rather than a topic: clients label
 * the row with the catalog name, so it reads "Newsio - News".
 *
 * `isRequired: true` on the search extra keeps it out of Discover/Home --
 * it has nothing to show without a query, and would otherwise appear as an
 * empty browsable shelf.
 */
const SEARCH_CATALOG_ID = "search";
const SEARCH_CATALOG_NAME = "Newsio";

/**
 * How many catalog pages the client is told it can walk through.
 * 10 x 20 = 200 stories per catalog, which is far past where a news feed
 * stops being useful and keeps a deep scroll from draining the API quota.
 */
const CATALOG_PAGE_COUNT = 10;

/**
 * The steps in which the client asks for more.
 *
 * This is not cosmetic. Without `options`, "the standard page size in
 * Stremio is 100, so the skip value will be a multiple of 100" -- and,
 * worse, "if you return less than 100 items, Stremio will consider this to
 * be the end of the catalog". A 20-item page with no declared step is
 * therefore treated as the entire catalog: scrolling never asks for more,
 * and a client that does ask jumps straight to skip=100, five upstream
 * pages past anything fetched. Declaring the steps is what makes a page
 * size other than 100 paginate at all.
 */
const SKIP_OPTIONS = Array.from({ length: CATALOG_PAGE_COUNT }, (_, i) => String(i * CATALOG_PAGE_SIZE));

function skipExtra() {
  return { name: "skip", options: SKIP_OPTIONS };
}

/**
 * One catalog per topic, named for it. A custom topic is no different here:
 * its id carries the q_ prefix and its name is the text the user typed.
 */
function topicCatalog(topic) {
  return {
    type: CONTENT_TYPE,
    id: topic.id,
    name: topic.label,
    extra: [skipExtra()]
  };
}

function searchCatalog() {
  return {
    type: CONTENT_TYPE,
    id: SEARCH_CATALOG_ID,
    name: SEARCH_CATALOG_NAME,
    extra: [{ name: "search", isRequired: true }, skipExtra()]
  };
}

/**
 * Listing credential for https://stremio-addons.net.
 *
 * Claiming an addon there issues a signature that the manifest must echo
 * back as `stremioAddonsConfig` to prove ownership. This one belongs to
 * https://newsio.up.railway.app/manifest.json.
 *
 * It is committed rather than kept in the environment. It reads like a
 * credential, but it is served verbatim to every client that fetches the
 * manifest -- it is public by construction, so hiding it bought nothing
 * while risking the verified badge silently vanishing if the variable were
 * ever dropped. It is also bound to the manifest URL above, so it cannot be
 * reused to claim a different addon.
 *
 * A fork deploying to its own host needs its own signature: override with
 * STREMIO_ADDONS_CONFIG_SIGNATURE (and STREMIO_ADDONS_CONFIG_ISSUER) rather
 * than editing this file, since this one will not validate for another URL.
 */
const STREMIO_ADDONS_ISSUER = "https://stremio-addons.net";
const STREMIO_ADDONS_SIGNATURE =
  "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..Z71i61P4KsKCep97-S7_SA.NCWCuO1Mr-1HydcNM0IAJEzFCKshMaeEPGJ0Vai4YtrqUeiuDXGajDRisu4CpDawYYPVIMJA7Ay8G-1KJijCOM0c-4OBAyFYinFCK_aQaBkvy49E_INGPuCHFPle8IST.f-bNhW5MzGrVuN-65LoHsg";

function getStremioAddonsConfig() {
  return {
    issuer: process.env.STREMIO_ADDONS_CONFIG_ISSUER || STREMIO_ADDONS_ISSUER,
    signature: process.env.STREMIO_ADDONS_CONFIG_SIGNATURE || STREMIO_ADDONS_SIGNATURE
  };
}

/**
 * The user's topics, in their order -- which is the order their catalogs
 * appear in Stremio. Normalized here rather than trusted: buildManifest is
 * exported and must not throw on a hand-built object.
 */
function selectedTopics(config) {
  return normalizeTopics(config && config.topics);
}

/**
 * The manifest actually served to Stremio (both the bare, unconfigured one
 * and the per-user configured one).
 *
 * Configuration is mandatory, which the addon protocol expresses as
 * `behaviorHints.configurationRequired: true`: Stremio then hides "Install"
 * entirely and shows "Configure" instead, pointing at /configure on this
 * host. It is set on the bare manifest and on any incomplete one.
 *
 * Deliberately has no native `config` array. The SDK auto-generates a
 * settings form from that array and makes the landing page use it, which
 * would replace our own /configure page (topic checkboxes, language picker,
 * install-link builder) with a flat list of fields. `configurable: true`
 * plus a page served at /configure is the documented way to keep a custom
 * configuration page -- see the SDK's advanced.md, "Creating Addon
 * Configuration Pages".
 */
function baseManifest(baseUrl) {
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: "Newsio",
    description: DESCRIPTION,
    // Versioned so a client that cached an earlier logo re-fetches it.
    // Stremio clients cache addon artwork by URL, so replacing the bytes at
    // a fixed path leaves the old image on screen indefinitely -- which is
    // exactly how a stale placeholder outlives the asset it replaced.
    logo: `${baseUrl}/logo.png?v=${ADDON_VERSION}`,
    background: `${baseUrl}/background.png?v=${ADDON_VERSION}`,
    contactEmail: CONTACT_EMAIL,
    resources: ["catalog", "meta", "stream"],
    types: [CONTENT_TYPE],
    idPrefixes: ID_PREFIXES,
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: true
    },
    stremioAddonsConfig: getStremioAddonsConfig()
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
  // An incomplete config is served as if it were no config at all: no
  // catalogs, and configuration still required. Advertising catalogs for a
  // config that cannot fetch anything would let the addon install into a
  // permanently empty state, with nothing in the UI explaining why.
  const configured = isConfigured(config);
  const topics = selectedTopics(config);

  return {
    ...baseManifest(baseUrl),
    catalogs: configured ? [...topics.map(topicCatalog), searchCatalog()] : [],
    behaviorHints: {
      configurable: true,
      configurationRequired: !configured
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
    idPrefixes: ID_PREFIXES,
    catalogs: [...TOPICS.map(topicCatalog), searchCatalog()],
    config: [{ key: "apiKey", type: "password", title: "API Key" }],
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
  ADDON_VERSION,
  DESCRIPTION,
  SEARCH_CATALOG_ID,
  SEARCH_CATALOG_NAME,
  SKIP_OPTIONS,
  CATALOG_PAGE_COUNT,
  STREMIO_ADDONS_ISSUER,
  STREMIO_ADDONS_SIGNATURE
};
