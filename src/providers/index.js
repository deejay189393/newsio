const newsdata = require("./newsdata");
const currents = require("./currents");
const gnews = require("./gnews");
const youtube = require("./youtube");

/**
 * Every news API the addon can read from, in the order they are offered on
 * the configure page: freshest first, because that is the order most users
 * should run them in.
 */
const PROVIDERS = [currents, newsdata, youtube, gnews];
const PROVIDERS_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/**
 * Canonical topics live in ../topics; each provider maps them to its own
 * vocabulary. A mapping is either a category string, an object of extra
 * query parameters (for a topic that is a filter rather than a subject,
 * like "video"), or null when that provider cannot serve the topic at all
 * and should be skipped for it.
 */
const { PRESET_TOPICS, getPresetTopic, getTopicLabel, isPresetTopicId } = require("../topics");
const TOPICS = PRESET_TOPICS;

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "ru", label: "Russian" },
  { code: "zh", label: "Chinese" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" }
];

const VALID_LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

function getProvider(id) {
  return PROVIDERS_BY_ID.get(id);
}

function isValidProviderId(id) {
  return PROVIDERS_BY_ID.has(id);
}

/** Can this provider serve this canonical topic at all? */
function providerSupportsTopic(provider, topicId) {
  return Boolean(provider && provider.categories[topicId]);
}

/** The provider that issued an article id, identified by its prefix. */
function providerForArticleId(id) {
  if (typeof id !== "string") return undefined;
  return PROVIDERS.find((p) => id.startsWith(p.idPrefix));
}

module.exports = {
  PROVIDERS,
  getProvider,
  isValidProviderId,
  providerSupportsTopic,
  providerForArticleId,
  TOPICS,
  getTopicById: getPresetTopic,
  getTopicLabel,
  isValidTopicId: isPresetTopicId,
  LANGUAGES,
  VALID_LANGUAGE_CODES
};
