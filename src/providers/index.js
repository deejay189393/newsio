const newsdata = require("./newsdata");
const currents = require("./currents");
const gnews = require("./gnews");

/**
 * Every news API the addon can read from, in the order they are offered on
 * the configure page: freshest first, because that is the order most users
 * should run them in.
 */
const PROVIDERS = [currents, newsdata, gnews];
const PROVIDERS_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/**
 * Canonical topics.
 *
 * Each provider has its own category vocabulary, so catalogs are defined in
 * these ids and each provider maps them to whatever it calls the same thing
 * (`tourism` is "tourism" to newsdata.io and "travel" to Currents). That
 * keeps a catalog's identity stable no matter which source ends up serving
 * it -- which matters, because Stremio caches the manifest and a user's
 * installed catalogs must not shift when a source fails over.
 *
 * A provider that has no equivalent for a topic maps it to null and is
 * skipped for that catalog rather than asked something it cannot answer.
 */
const TOPICS = [
  { id: "top", label: "Top Stories" },
  { id: "world", label: "World" },
  { id: "business", label: "Finance & Business" },
  { id: "technology", label: "Technology" },
  { id: "science", label: "Science" },
  { id: "health", label: "Health" },
  { id: "sports", label: "Sports" },
  { id: "entertainment", label: "Entertainment" },
  { id: "politics", label: "Politics" },
  { id: "environment", label: "Environment" },
  { id: "food", label: "Food" },
  { id: "lifestyle", label: "Lifestyle" },
  { id: "education", label: "Education" },
  { id: "tourism", label: "Tourism & Travel" },
  { id: "crime", label: "Crime" },
  { id: "domestic", label: "Domestic" },
  { id: "other", label: "Other" }
];

const TOPICS_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));

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

function getTopicById(id) {
  return TOPICS_BY_ID.get(id);
}

function isValidTopicId(id) {
  return TOPICS_BY_ID.has(id);
}

function getTopicLabel(id) {
  const topic = TOPICS_BY_ID.get(id);
  return topic ? topic.label : null;
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
  getTopicById,
  getTopicLabel,
  isValidTopicId,
  LANGUAGES,
  VALID_LANGUAGE_CODES
};
