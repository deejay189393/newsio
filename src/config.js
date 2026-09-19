const { TOPICS } = require("./topics");

const VALID_TOPIC_IDS = new Set(TOPICS.map((t) => t.id));

/**
 * Encode a config object {apiKey, topics, language} into a URL-safe string
 * that Stremio will carry around as the first path segment of every
 * addon request, e.g. /<config>/manifest.json
 */
function encodeConfig(config) {
  const json = JSON.stringify({
    apiKey: config.apiKey || "",
    topics: Array.isArray(config.topics) ? config.topics : [],
    language: config.language || "en"
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode a config string back into an object. Returns null if it can't be
 * parsed or doesn't look like a config at all (lets callers fall back to
 * treating the segment as something else, e.g. "manifest.json" itself).
 */
function decodeConfig(str) {
  if (!str) return null;
  try {
    const json = Buffer.from(str, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;

    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.filter((t) => VALID_TOPIC_IDS.has(t))
      : [];

    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      topics,
      language: typeof parsed.language === "string" && parsed.language ? parsed.language : "en"
    };
  } catch (err) {
    return null;
  }
}

module.exports = { encodeConfig, decodeConfig };
