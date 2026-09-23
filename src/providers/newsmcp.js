const { realText, makeArticleId, assembleCatalogPage, sourceNameFromUrl, CATALOG_PAGE_SIZE } = require("../articles");
const { catalogCache, articleCache } = require("../cache");

/**
 * NewsMCP by NewsCatcher (newsmcp.com) -- live news clustered into story
 * events, readable without a key.
 *
 * Not the NewsMCP that lived at newsmcp.io: that one shut down and answers
 * 410 on every endpoint. This is a different service from a news-API
 * company, with a plain REST twin of its MCP server, and its terms license
 * the output for exactly this -- incorporated into a product and shown to
 * that product's own users, provided source links and dates are kept.
 *
 * What makes it unlike the other four, all measured against the live API:
 *
 *   - Results are events, not articles. Every outlet covering one story is
 *     collapsed into one result with a generated headline and abstract, up
 *     to three source links, and a count of independent newsrooms.
 *   - Those headlines are NewsMCP's own English text, whatever language the
 *     sources were in -- a Bundesliga story from German outlets comes back
 *     as "German Bundesliga Kicks Off". So it serves English only.
 *   - There is no paging. One call returns up to `limit` events and that is
 *     the whole result: 20 keyless, 50 with a key.
 *   - No images, no video. Items use the addon's fallback artwork.
 *   - One request in flight per caller, and an hourly call budget: 20 keyless
 *     (shared by everyone behind the same IP -- here, every Newsio user on
 *     this server), 50 with a free key.
 */

const BASE_URL = "https://api.newsmcp.com/v0";
const ID_PREFIX = "nm_";

/**
 * NewsMCP refuses generic scanner user agents -- Python's default is
 * answered 403 "malicious_bot_ua" -- so the addon says what it is.
 */
const USER_AGENT = "Newsio (+https://github.com/deejay189393/newsio)";

/** Events per call: the keyless ceiling, and the most any plan allows. */
const KEYLESS_LIMIT = 20;
const KEYED_LIMIT = 50;

/**
 * One call is the whole result, so it is treated as a single upstream page
 * big enough to hold any plan's batch; a skip past it is simply the end.
 */
const UPSTREAM_PAGE_SIZE = KEYED_LIMIT;

/**
 * An hour, like YouTube's search pages. The keyless budget is 20 calls an
 * hour for the whole server, so a batch is kept for as long as that budget
 * takes to refill; a preset topic then costs one call an hour however many
 * people browse it.
 */
const BATCH_TTL_MS = 60 * 60 * 1000;

/** Calls are serialized per caller, so one that hangs must not hold the queue. */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * A 429 that quotes no wait means two calls were in flight at once rather
 * than that the budget is spent. The queue below prevents that within this
 * process, but the keyless allowance is per IP and the IP is shared, so it
 * can still happen; one retry after a short pause is what the API asks for.
 */
const COLLISION_RETRY_MS = 1500;

/**
 * Canonical topic -> the filters that select it.
 *
 * NewsMCP has no category parameter. It labels every event with an industry
 * `sector` and a typed `event_type`, and has a `content_type` for the form
 * of the reporting, so each topic is expressed in whichever of those
 * describes it -- checked against the live index, where every mapping here
 * returned on-topic stories. Feeds rank by `trending`: independent
 * newsrooms weighted by freshness, so a big story from yesterday yields to a
 * growing one from this morning.
 */
const TRENDING = { sort: "trending" };

const CATEGORIES = {
  // news_report strips the press-release wire, which otherwise crowds a
  // topic-less feed.
  top: { ...TRENDING, content_type: "news_report" },
  world: {
    ...TRENDING,
    event_type: "geopolitics.armed_conflict,geopolitics.sanctions,geopolitics.diplomacy_summit,politics.diplomacy"
  },
  business: {
    ...TRENDING,
    event_type: [
      "corporate_finance.earnings_report",
      "corporate_finance.analyst_rating",
      "corporate_finance.dividends",
      "markets.stock_move",
      "markets.commodity_price",
      "markets.currency_move",
      "deals.merger_acquisition",
      "deals.ipo_filing",
      "deals.asset_sale",
      "macro_policy.central_bank_decision",
      "macro_policy.trade_policy",
      "macro_policy.fiscal_policy",
      "funding.venture_funding_round",
      "operations.layoffs"
    ].join(",")
  },
  technology: { ...TRENDING, sector: "software_it_services,semiconductors,telecommunications" },
  // Discoveries only: "publication" also labels surveys and statistics
  // releases ("Mexico's Fertility Rate Drops"), which read as anything but.
  science: { ...TRENDING, event_type: "research_science.scientific_discovery" },
  health: { ...TRENDING, sector: "healthcare_pharma,biotechnology" },
  sports: { ...TRENDING, sector: "sports_recreation" },
  entertainment: {
    ...TRENDING,
    event_type: "culture_media.celebrity_news,culture_media.entertainment_release,culture_media.award"
  },
  politics: { ...TRENDING, event_type: "politics.election,politics.policy_announcement,politics.diplomacy" },
  environment: {
    ...TRENDING,
    event_type:
      "society_environment.climate_event,society_environment.environmental_incident,accidents_disasters.natural_disaster"
  },
  food: { ...TRENDING, sector: "agriculture_food" },
  // The loosest fit: there is no lifestyle sector, and human-interest
  // reporting is the nearest thing the index labels.
  lifestyle: { ...TRENDING, content_type: "human_interest" },
  education: { ...TRENDING, sector: "education" },
  tourism: { ...TRENDING, sector: "hospitality_travel" },
  crime: {
    ...TRENDING,
    event_type: "justice_crime.arrest_charge,justice_crime.trial_verdict,justice_crime.investigation"
  },
  domestic: null, // no country filter at all, so "my country's news" cannot be asked for
  video: null // no video in this API
};

/** Its headlines are generated in English whatever the source language. */
const LANGUAGES = ["en"];

/** Industry sector -> a tag a reader would recognize. */
const SECTOR_LABELS = {
  government_public_sector: "Government",
  media_entertainment: "Media",
  financial_services: "Finance",
  healthcare_pharma: "Healthcare",
  energy_utilities: "Energy",
  retail_consumer: "Retail",
  real_estate: "Real Estate",
  agriculture_food: "Agriculture",
  telecommunications: "Telecoms",
  automotive: "Automotive",
  manufacturing_industrial: "Manufacturing",
  transport_logistics: "Transport",
  aerospace_defense: "Aerospace",
  mining_metals: "Mining",
  construction_infrastructure: "Infrastructure",
  education: "Education",
  hospitality_travel: "Travel",
  sports_recreation: "Sports",
  nonprofit_ngo: "Nonprofits",
  legal_services: "Legal",
  insurance: "Insurance",
  software_it_services: "Software",
  ecommerce: "E-commerce",
  banking: "Banking",
  defense_security: "Security",
  chemicals: "Chemicals",
  fashion_apparel: "Fashion",
  gaming_esports: "Gaming",
  biotechnology: "Biotech",
  semiconductors: "Semiconductors"
};

// ---------------------------------------------------------------------------
// Turning what a person typed into what the index understands.
// ---------------------------------------------------------------------------

/**
 * NewsMCP's `q` is strict boolean: bare words are ANDed, and AND/OR/NOT and
 * parentheses are operators. Custom topics are written as plain English, so
 * passed verbatim three of the seven in a real config returned nothing --
 * "Latest Netflix Movies & Reviews" requires the word "Latest", "Best New TV
 * Shows in India" requires "Best". Its MCP endpoint strips filler, but
 * measured on those same three it still returned nothing, so the
 * translation is done here, where it can be tested.
 *
 * Anyone writing the syntax on purpose -- a quoted phrase, or AND/OR/NOT in
 * capitals -- gets it passed through untouched.
 */
const EXPLICIT_SYNTAX = /"|\b(AND|OR|NOT)\b/;

/** Words that are never the subject of a news search. */
const FILLER = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "from", "by",
  "with", "about", "into", "over", "under", "is", "are", "was", "were", "be",
  "latest", "best", "top", "news", "story", "stories", "headline", "headlines",
  "update", "updates", "breaking", "today", "lot", "lots", "much", "many", "more", "less"
]);

/**
 * "not X", "without X": the next real word is excluded. The filler between
 * is skipped, so "Not a lot of Trump" excludes Trump -- the nearest thing a
 * keyword index has to "less of".
 */
const NEGATORS = new Set(["not", "without", "except", "excluding"]);

/** Operator characters a person types as punctuation. */
const OPERATOR_CHARS = /[()&|!*]/g;

/** Trim punctuation off a word's ends, keeping "3-0", "Women's" and "AC/DC". */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

function words(text) {
  return text
    .replace(OPERATOR_CHARS, " ")
    .split(/\s+/)
    .map((w) => w.replace(EDGE_PUNCTUATION, ""))
    .filter(Boolean);
}

/**
 * The search a query becomes.
 *
 *   { q }                      search for q, ranked by relevance
 *   { q, relaxedQ }            ...and if q finds less than a full batch,
 *                              fill the rest from relaxedQ (every word ORed)
 *   { general: true, q? }      nothing to search for -- "Top Stories" is all
 *                              filler -- so it is the top-stories feed, minus
 *                              anything excluded
 *
 * A comma means "any of these": "Anthropic, OpenAI, AI" was meant as three
 * alternatives, and ANDed it matched 66 stories where ORed it matched 5,639.
 */
function toSearch(text) {
  const raw = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  if (EXPLICIT_SYNTAX.test(raw)) return { q: raw };

  const excluded = [];
  const groups = raw
    .split(/[,;]+/)
    .map((part) => {
      const kept = [];
      let negateNext = false;
      words(part).forEach((word) => {
        const lower = word.toLowerCase();
        if (NEGATORS.has(lower)) {
          negateNext = true;
        } else if (FILLER.has(lower)) {
          // skipped, and a pending "not" carries over it
        } else if (negateNext) {
          excluded.push(word);
          negateNext = false;
        } else {
          kept.push(word);
        }
      });
      return kept;
    })
    .filter((group) => group.length);

  const exclusions = [...new Set(excluded)].map((w) => `NOT ${w}`).join(" ");
  if (!groups.length) return exclusions ? { general: true, q: exclusions } : { general: true };

  const alternatives = groups.map((group) => group.join(" "));
  const positive =
    alternatives.length === 1
      ? alternatives[0]
      : alternatives.map((a) => (a.includes(" ") ? `(${a})` : a)).join(" OR ");
  const withExclusions = (expr) => (exclusions ? `(${expr}) ${exclusions}` : expr);

  const allWords = [...new Set(groups.flat())];
  // Relaxing only changes anything when some alternative has several words
  // that are currently all required.
  const relaxable = groups.some((group) => group.length > 1);

  return relaxable
    ? { q: withExclusions(positive), relaxedQ: withExclusions(allWords.join(" OR ")) }
    : { q: withExclusions(positive) };
}

// ---------------------------------------------------------------------------
// Collapsing what the clustering missed.
// ---------------------------------------------------------------------------

/**
 * NewsMCP's clustering is good but not perfect: one search for "Arsenal"
 * returned six separate events for the same match -- "Brighton Beats
 * Arsenal 3-0" twice, "Brighton Defeats Arsenal 3-0" twice, "Arsenal Loses
 * to Brighton 3-0", and a transliterated "Brajton".
 *
 * Two headlines are the same story when their words overlap by at least
 * 0.6 of all the words either uses (Jaccard), with at least three shared,
 * and they were seen within two days of each other. Measured on real
 * batches, that line separated cleanly: every true duplicate pair scored
 * 0.60 or more, every distinct pair 0.50 or less. The union matters. An
 * earlier version measured against the shorter headline only, and in a
 * search, where every result shares the searched words, it merged "India
 * Women's Cricket Team Reaches Semifinals" into "India Announces Cricket
 * Team". The time window keeps a recurring headline -- a weekly figure, a
 * daily schedule -- from being merged across a week.
 */
const HEADLINE_CONNECTIVES = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "from", "by", "with",
  "and", "or", "as", "is", "are", "after", "against", "over", "into", "amid"
]);
const DUPLICATE_OVERLAP = 0.6;
const DUPLICATE_MIN_SHARED = 3;
const SAME_STORY_WINDOW_MS = 48 * 60 * 60 * 1000;

function headlineWords(headline) {
  return new Set(
    String(headline || "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}-]+/u)
      .filter((w) => w.length > 1 && !HEADLINE_CONNECTIVES.has(w))
  );
}

/** NewsMCP's timestamps carry no zone and are UTC. */
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

function seenAt(article) {
  const stamp = article.pubDate ? String(article.pubDate) : "";
  const t = Date.parse(stamp && !HAS_ZONE.test(stamp) ? `${stamp}Z` : stamp);
  return Number.isFinite(t) ? t : null;
}

function isSameStory(a, b) {
  let shared = 0;
  a.words.forEach((word) => {
    if (b.words.has(word)) shared += 1;
  });
  const union = a.words.size + b.words.size - shared;
  if (shared < DUPLICATE_MIN_SHARED || shared / union < DUPLICATE_OVERLAP) return false;
  return a.at === null || b.at === null || Math.abs(a.at - b.at) <= SAME_STORY_WINDOW_MS;
}

/** Keeps the first -- the higher-ranked -- of each set of near-duplicates. */
function collapseNearDuplicates(articles) {
  const kept = [];
  const seen = [];
  articles.forEach((article) => {
    const story = { words: headlineWords(article.title), at: seenAt(article) };
    if (seen.some((prior) => isSameStory(story, prior))) return;
    kept.push(article);
    seen.push(story);
  });
  return kept;
}

// ---------------------------------------------------------------------------
// Events -> articles.
// ---------------------------------------------------------------------------

function isWebUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch (_) {
    return false;
  }
}

/**
 * An event, as the article shape the rest of the addon reads.
 *
 * `last_seen` is the date shown: an event is a story still being reported,
 * and when it was last covered is what tells a reader whether it is current.
 * Every source link is kept, both because a reader may prefer one outlet to
 * another and because the terms require source links to be preserved.
 */
function normalize(event) {
  const sources = (Array.isArray(event.sources) ? event.sources : [])
    .filter(isWebUrl)
    .map((url) => ({ name: sourceNameFromUrl(url), url }));
  const lead = sources[0];

  const entities = (Array.isArray(event.entities) ? event.entities : [])
    .filter((e) => e && typeof e.name === "string" && e.name.trim())
    .sort((a, b) => (Number(b.salience) || 0) - (Number(a.salience) || 0))
    .map((e) => realText(e.name));

  const sector = SECTOR_LABELS[event.sector];

  return {
    id: makeArticleId(ID_PREFIX, { id: event.event_id, link: lead && lead.url, title: event.headline }),
    title: realText(event.headline) || "Untitled",
    description: realText(event.abstract) || realText(event.one_liner),
    link: lead ? lead.url : null,
    sources,
    image: null,
    videoUrl: null,
    pubDate: event.last_seen || event.first_seen || null,
    sourceName: lead ? lead.name : "NewsMCP",
    sourceId: null,
    sourcePriority: null,
    sourceIcon: null,
    categories: sector ? [sector] : [],
    keywords: entities,
    creator: null,
    provider: "newsmcp"
  };
}

// ---------------------------------------------------------------------------
// Talking to the API.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request in flight per caller: NewsMCP answers a second concurrent one
 * with 429. Stremio loads every catalog on a screen at once, so without this
 * all but one of them would fail. Keyless callers share one queue, because
 * the API counts them by IP and they all share this server's.
 */
const queues = new Map();

function serialized(slot, task) {
  const previous = queues.get(slot) || Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => {},
    () => {}
  );
  queues.set(slot, tail);
  tail.then(() => {
    if (queues.get(slot) === tail) queues.delete(slot);
  });
  return run;
}

/** The wait a 429 quotes, in ms -- from the body or the Retry-After header. */
function retryAfterMs(response, body) {
  const quoted = Number(
    (body && (body.retry_after_seconds !== undefined ? body.retry_after_seconds : body.retry_after)) ||
      response.headers.get("retry-after")
  );
  return Number.isFinite(quoted) && quoted > 0 ? quoted * 1000 : null;
}

async function request(path, params, apiKey, { wait = sleep, retried = false } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  // Every caller builds these itself, from filters that are never empty.
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const headers = { "user-agent": USER_AGENT, accept: "application/json" };
  // REST takes the key in this header only; one in the URL is ignored.
  if (apiKey) headers["x-api-key"] = apiKey;

  let response;
  try {
    response = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // Includes the refused connection a datacenter IP gets when keyless.
    const wrapped = new Error(`Could not reach NewsMCP: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    /* not JSON */
  }

  if (response.ok && body) return body;

  const wait429 = response.status === 429 ? retryAfterMs(response, body) : null;
  if (response.status === 429 && !wait429 && !retried) {
    await wait(COLLISION_RETRY_MS);
    return request(path, params, apiKey, { wait, retried: true });
  }

  const message = (body && body.message) || `NewsMCP returned HTTP ${response.status}`;
  const err = new Error(message);
  err.status = response.ok ? 502 : response.status;
  if (body && body.error_code) err.code = body.error_code;
  if (wait429) err.retryAfterMs = wait429;
  throw err;
}

function call(path, params, apiKey, options) {
  return serialized(apiKey || "keyless", () => request(path, params, apiKey, options));
}

// ---------------------------------------------------------------------------
// The provider interface.
// ---------------------------------------------------------------------------

const batchKey = (filters, tier) => `newsmcp::${tier}::${JSON.stringify(filters)}`;

/**
 * The filters one catalog request becomes -- a preset topic's own, or a
 * query's search -- plus the relaxed query to fill from, if there is one.
 */
function filtersFor({ topic, query }) {
  if (!query) {
    const preset = CATEGORIES[topic];
    return preset ? { filters: preset, relaxedQ: null } : null;
  }
  const search = toSearch(query);
  if (search.general) {
    return { filters: search.q ? { ...CATEGORIES.top, q: search.q } : CATEGORIES.top, relaxedQ: null };
  }
  return { filters: { q: search.q }, relaxedQ: search.relaxedQ || null };
}

/**
 * The batch for one request: the strict search, then -- only when that
 * found less than a full batch -- the relaxed one, so exact matches lead and
 * the closest others fill in behind them. A narrow query costs a second call;
 * a broad one never does.
 */
async function fetchBatch({ filters, relaxedQ }, apiKey, limit, options) {
  const strict = await call("/news", { ...filters, limit }, apiKey, options);
  let events = Array.isArray(strict.events) ? strict.events : [];

  if (relaxedQ && events.length < limit) {
    const relaxed = await call("/news", { ...filters, q: relaxedQ, limit }, apiKey, options);
    const seen = new Set(events.map((e) => e.event_id));
    const extra = (Array.isArray(relaxed.events) ? relaxed.events : []).filter((e) => !seen.has(e.event_id));
    events = [...events, ...extra].slice(0, limit);
  }

  const articles = collapseNearDuplicates(events.map(normalize).filter((a) => a.link));
  articles.forEach((a) => articleCache.set(a.id, a));
  return articles;
}

async function fetchPage({ apiKey, topic, query, skip }, options) {
  const plan = filtersFor({ topic, query });
  if (!plan) {
    const err = new Error(`NewsMCP has no filter for "${topic}"`);
    err.status = 404;
    throw err;
  }

  const tier = apiKey ? "keyed" : "keyless";
  const limit = apiKey ? KEYED_LIMIT : KEYLESS_LIMIT;
  const cacheKey = batchKey({ ...plan.filters, relaxedQ: plan.relaxedQ }, tier);

  const loadPage = async (index) => {
    // A single call is the whole result; there is nothing past it.
    if (index > 0) return { articles: [], hasMore: false };
    let articles = catalogCache.get(cacheKey);
    if (!articles) {
      articles = await fetchBatch(plan, apiKey, limit, options);
      catalogCache.set(cacheKey, articles, BATCH_TTL_MS);
    }
    return { articles, hasMore: false };
  };

  return assembleCatalogPage({ skip, upstreamPageSize: UPSTREAM_PAGE_SIZE, loadPage });
}

/**
 * One event by id, for a /meta or /stream request the cache cannot answer.
 *
 * Event ids are not durable -- they derive from cluster membership -- and
 * when a story is folded into a bigger one, looking up the old id is a 404
 * whose message names the new id. That id is followed once. The article
 * keeps the id it was asked for, since that is the one Stremio holds.
 */
async function getArticleById(apiKey, eventId, options) {
  const lookup = (id) => call(`/news/${encodeURIComponent(id)}`, {}, apiKey, options);
  let event;
  try {
    event = await lookup(eventId);
  } catch (err) {
    if (err.status !== 404) throw err;
    // Ids are hex today; letters and digits in general, in case that changes.
    const replacement = (String(err.message).match(/evt_[0-9a-z]+/gi) || []).find((id) => id !== eventId);
    if (!replacement) return null;
    try {
      event = await lookup(replacement);
    } catch (again) {
      if (again.status === 404) return null;
      throw again;
    }
  }

  const article = normalize(event);
  if (!article.link) return null;
  const resolved = { ...article, id: `${ID_PREFIX}${eventId}` };
  articleCache.set(resolved.id, resolved);
  return resolved;
}

module.exports = {
  id: "newsmcp",
  label: "NewsMCP",
  homepage: "https://newsmcp.com",
  signupUrl: "https://platform.newsmcp.com/auth",
  keyPlaceholder: "optional — your NewsMCP key",
  notes:
    "No key needed. World news from NewsCatcher, with every outlet covering a story merged into one item. English only; no pictures or video. Without a key: 20 stories per catalog and 20 requests an hour, shared by everyone using this server. A free key raises both to 50.",
  // Works without a key; a key only raises the limits.
  keyOptional: true,
  idPrefix: ID_PREFIX,
  supportsVideo: false,
  categories: CATEGORIES,
  languages: LANGUAGES,
  fetchPage,
  getArticleById,
  normalize,
  toSearch,
  collapseNearDuplicates,
  filtersFor,
  KEYLESS_LIMIT,
  KEYED_LIMIT,
  UPSTREAM_PAGE_SIZE,
  BATCH_TTL_MS,
  REQUEST_TIMEOUT_MS,
  COLLISION_RETRY_MS,
  USER_AGENT,
  CATALOG_PAGE_SIZE
};
