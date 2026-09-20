const { isValidTopicId, VALID_LANGUAGE_CODES } = require("./topics");

/**
 * User configuration is carried in the URL as the first path segment,
 * exactly the way stremio-addon-sdk's own getRouter expects it: a JSON
 * object, percent-encoded as a single path segment, i.e.
 *
 *     encodeURIComponent(JSON.stringify({ apiKey, topics, language }))
 *     -> /%7B%22apiKey%22...%7D/manifest.json
 *
 * Using the SDK's native convention (rather than a bespoke base64 scheme)
 * means the SDK router decodes and JSON.parses the segment for us on the
 * catalog/meta/stream routes and hands each handler a real `config` object.
 *
 * Nothing is persisted server-side: the user's key lives only inside their
 * own personal addon URL.
 */
function encodeConfig(config) {
  const json = JSON.stringify({
    apiKey: config.apiKey || "",
    topics: Array.isArray(config.topics) ? config.topics : [],
    language: config.language || "en"
  });
  return encodeURIComponent(json);
}

/**
 * Decode a config path segment into a validated object, or null if it is
 * missing / not JSON / not our shape. Accepts the segment either still
 * percent-encoded or already decoded (Express decodes route params for us),
 * so the same helper works from both the HTTP layer and tests.
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

  const topics = Array.isArray(parsed.topics) ? parsed.topics.filter(isValidTopicId) : [];
  const language =
    typeof parsed.language === "string" && VALID_LANGUAGE_CODES.has(parsed.language) ? parsed.language : "en";

  return {
    apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
    topics,
    language
  };
}

function maybeDecode(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    // Contains a literal % that isn't a valid escape -- already decoded.
    return raw;
  }
}

module.exports = { encodeConfig, decodeConfig };
