// Topics offered on the configuration page. Each one the user selects
// becomes its own catalog in Stremio, named after the topic's label.
// `category` is the value sent to newsdata.io's `category` query param.
// See: https://newsdata.io/documentation (category field)
const TOPICS = [
  { id: "top", category: "top", label: "Top Stories" },
  { id: "world", category: "world", label: "World" },
  { id: "business", category: "business", label: "Finance & Business" },
  { id: "technology", category: "technology", label: "Technology" },
  { id: "science", category: "science", label: "Science" },
  { id: "health", category: "health", label: "Health" },
  { id: "sports", category: "sports", label: "Sports" },
  { id: "entertainment", category: "entertainment", label: "Entertainment" },
  { id: "politics", category: "politics", label: "Politics" },
  { id: "environment", category: "environment", label: "Environment" },
  { id: "food", category: "food", label: "Food" },
  { id: "lifestyle", category: "lifestyle", label: "Lifestyle" },
  { id: "education", category: "education", label: "Education" },
  { id: "tourism", category: "tourism", label: "Tourism & Travel" },
  { id: "crime", category: "crime", label: "Crime" },
  { id: "domestic", category: "domestic", label: "Domestic" },
  { id: "other", category: "other", label: "Other" }
];

const TOPICS_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));

function getTopicById(id) {
  return TOPICS_BY_ID.get(id);
}

function isValidTopicId(id) {
  return TOPICS_BY_ID.has(id);
}

/**
 * The display label for a newsdata.io category id, when we have one.
 * Used to turn the raw ids it returns ("business") into the names the
 * configure page already uses ("Finance & Business").
 */
function getTopicLabel(id) {
  const topic = TOPICS_BY_ID.get(id);
  return topic ? topic.label : null;
}

// Languages supported by newsdata.io (common subset).
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

module.exports = { TOPICS, getTopicById, getTopicLabel, isValidTopicId, LANGUAGES, VALID_LANGUAGE_CODES };
