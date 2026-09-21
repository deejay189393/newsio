/**
 * Topics — the things that become catalogs.
 *
 * Two kinds, and the list is ordered: the order the user puts them in is the
 * order their catalogs appear in Stremio, so this is a list rather than a set.
 *
 *   preset  a curated subject each provider maps to its own category
 *           vocabulary ("tourism" is "travel" to Currents)
 *   custom  free text the user typed, run as a search and presented as a
 *           catalog of its own -- "FIFA World Cup" is not a category any
 *           news API has, but it is a perfectly good standing query
 */

const PRESET_TOPICS = [
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
  // Not a subject but a filter: stories that carry a playable video. Only
  // newsdata.io can serve it, so the others are skipped for this catalog.
  { id: "video", label: "Video News" }
];

const PRESETS_BY_ID = new Map(PRESET_TOPICS.map((t) => [t.id, t]));

/**
 * Custom catalog ids are prefixed so the handler can tell at a glance that
 * an id is a standing query rather than a preset, without consulting the
 * config first.
 */
const CUSTOM_PREFIX = "q_";

/** Keeps the install URL sane, and a runaway paste out of the manifest. */
const MAX_CUSTOM_TOPICS = 12;
const MAX_QUERY_LENGTH = 60;

function isPresetTopicId(id) {
  return PRESETS_BY_ID.has(id);
}

function getPresetTopic(id) {
  return PRESETS_BY_ID.get(id);
}

function getTopicLabel(id) {
  const preset = PRESETS_BY_ID.get(id);
  return preset ? preset.label : null;
}

function isCustomTopicId(id) {
  return typeof id === "string" && id.startsWith(CUSTOM_PREFIX);
}

/** Collapse runs of whitespace so " FIFA  World Cup " and "FIFA World Cup" match. */
function tidyQuery(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * A stable, URL-safe catalog id for a query.
 *
 * Derived from the text rather than random, so the same query always yields
 * the same catalog — re-saving an unchanged config must not orphan the
 * catalogs Stremio has already installed.
 */
function customTopicId(query) {
  const slug = tidyQuery(query)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${CUSTOM_PREFIX}${slug}` : null;
}

/**
 * Normalize whatever the URL carried into an ordered list of topics.
 *
 * Accepts a preset as a bare string or `{ id }`, and a custom topic as
 * `{ q }` or `{ query }`. Order is preserved exactly, because it is the
 * setting: it decides catalog order in the manifest.
 */
function normalizeTopics(raw) {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const topics = [];
  let customCount = 0;

  for (const entry of raw) {
    const topic = normalizeTopic(entry);
    if (!topic || seen.has(topic.id)) continue;
    if (topic.kind === "custom") {
      if (customCount >= MAX_CUSTOM_TOPICS) continue;
      customCount++;
    }
    seen.add(topic.id);
    topics.push(topic);
  }
  return topics;
}

function normalizeTopic(entry) {
  if (typeof entry === "string") {
    return isPresetTopicId(entry) ? { kind: "preset", id: entry, label: getTopicLabel(entry) } : null;
  }
  if (!entry || typeof entry !== "object") return null;

  if (typeof entry.id === "string" && isPresetTopicId(entry.id)) {
    return { kind: "preset", id: entry.id, label: getTopicLabel(entry.id) };
  }

  const query = tidyQuery(entry.q !== undefined ? entry.q : entry.query);
  if (!query || query.length > MAX_QUERY_LENGTH) return null;
  const id = customTopicId(query);
  // A query of nothing but punctuation has no usable id, and nothing to search.
  return id ? { kind: "custom", id, label: query, query } : null;
}

/**
 * The compact form stored in the install URL: a preset is just its id, a
 * custom topic is `{ q }`. Keeps the URL short, since every byte of it is
 * carried on every request Stremio makes.
 */
function toStoredTopics(topics) {
  return topics.map((t) => (t.kind === "preset" ? t.id : { q: t.query }));
}

module.exports = {
  PRESET_TOPICS,
  PRESETS_BY_ID,
  CUSTOM_PREFIX,
  MAX_CUSTOM_TOPICS,
  MAX_QUERY_LENGTH,
  isPresetTopicId,
  getPresetTopic,
  getTopicLabel,
  isCustomTopicId,
  customTopicId,
  tidyQuery,
  normalizeTopics,
  toStoredTopics
};
