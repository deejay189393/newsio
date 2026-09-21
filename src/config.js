const { isValidProviderId, VALID_LANGUAGE_CODES, PROVIDERS } = require("./providers");
const { normalizeTopics, toStoredTopics } = require("./topics");

/**
 * User configuration is carried in the URL as the first path segment,
 * exactly the way stremio-addon-sdk's own getRouter expects it: a JSON
 * object, percent-encoded as a single path segment.
 *
 *     encodeURIComponent(JSON.stringify({ sources, topics, language }))
 *
 * `sources` is an ordered list of { provider, apiKey } -- the order is the
 * failover order, so the first one that answers serves the request.
 *
 * Nothing is persisted server-side: the user's keys live only inside their
 * own personal addon URL.
 */
function encodeConfig(config) {
  const normalized = normalizeConfig(config);
  return encodeURIComponent(
    JSON.stringify({
      sources: normalized.sources,
      // Stored compactly: a preset is its id, a custom topic is { q }.
      topics: toStoredTopics(normalized.topics),
      language: normalized.language,
      youtubePlayback: normalized.youtubePlayback
    })
  );
}

/**
 * The decoded, validated config the rest of the addon works with. `topics`
 * comes back as ordered objects rather than bare ids, because a custom topic
 * carries a query alongside its id -- and because the order is the setting.
 */
function normalizeConfig(config) {
  return {
    sources: normalizeSources(config && config.sources),
    topics: normalizeTopics(config && config.topics),
    language: validLanguage(config && config.language),
    youtubePlayback: validYoutubePlayback(config && config.youtubePlayback)
  };
}

/**
 * Which YouTube stream Nuvio should offer first.
 *
 * "app" puts in-app playback at the top, which is what almost everyone
 * wants. The setting exists because in-app playback leans on an
 * undocumented YouTube API: if that breaks, switching to "youtube" makes the
 * play button hand off to the YouTube app instead, without waiting for a fix.
 */
const YOUTUBE_PLAYBACK_MODES = ["app", "youtube"];
const DEFAULT_YOUTUBE_PLAYBACK = "app";

function validYoutubePlayback(mode) {
  return YOUTUBE_PLAYBACK_MODES.includes(mode) ? mode : DEFAULT_YOUTUBE_PLAYBACK;
}

/**
 * Keeps the user's ordering, drops anything unusable, and allows each
 * provider only once -- two keys for the same API would fail over into the
 * same quota.
 */
function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  const normalized = [];
  for (const entry of sources) {
    if (!entry || typeof entry !== "object") continue;
    const provider = entry.provider;
    const apiKey = typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";
    if (!isValidProviderId(provider) || !apiKey || seen.has(provider)) continue;
    seen.add(provider);
    normalized.push({ provider, apiKey });
  }
  return normalized;
}

function validLanguage(language) {
  return typeof language === "string" && VALID_LANGUAGE_CODES.has(language) ? language : "en";
}

/**
 * Decode a config path segment into a validated object, or null if it is
 * missing / not JSON / not our shape. Accepts the segment either still
 * percent-encoded or already decoded (Express decodes route params for us).
 */
function decodeConfig(raw) {
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(maybeDecode(raw));
  } catch (err) {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  return normalizeConfig(parsed);
}

function maybeDecode(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    // Contains a literal % that isn't a valid escape -- already decoded.
    return raw;
  }
}

/**
 * Is this configuration complete enough for the addon to work?
 *
 * Both halves are load-bearing. Without a source there is nothing to fetch
 * from, and without a topic there are no catalogs to fetch -- either way the
 * addon would install and then do nothing.
 */
function isConfigured(config) {
  return normalizeSources(config && config.sources).length > 0 && normalizeTopics(config && config.topics).length > 0;
}

/** The providers a config does not already use, for the configure page. */
function unusedProviders(config) {
  const used = new Set(normalizeSources(config && config.sources).map((s) => s.provider));
  return PROVIDERS.filter((p) => !used.has(p.id));
}

module.exports = {
  encodeConfig,
  decodeConfig,
  normalizeSources,
  isConfigured,
  unusedProviders,
  validYoutubePlayback,
  YOUTUBE_PLAYBACK_MODES,
  DEFAULT_YOUTUBE_PLAYBACK
};
