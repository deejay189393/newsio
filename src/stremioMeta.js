const { CONTENT_TYPE } = require("./manifest");
const { getTopicLabel } = require("./topics");
const { FALLBACK_POSTER, FALLBACK_BACKGROUND } = require("./fallbackImages");

/**
 * newsdata.io returns dates as "YYYY-MM-DD HH:MM:SS" in UTC. Stremio shows
 * `releaseInfo` verbatim, so we normalize to a plain date and drop it
 * entirely if the upstream value is missing or unparseable (better no date
 * than "Invalid Date" in the UI).
 */
function formatReleaseInfo(pubDate) {
  if (!pubDate) return undefined;
  const d = new Date(String(pubDate).replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

/**
 * Marker shown on stories that carry a playable video.
 *
 * It belongs on the *name*, because the name is the only text a catalog
 * grid puts under a poster. This used to prefix the description instead,
 * which is not rendered in the grid at all -- so the marker was invisible
 * at exactly the moment the user is choosing between "this plays" and
 * "this opens an article in a browser".
 *
 * A single glyph rather than a word like [VIDEO]: clients truncate these
 * titles hard (the grid shows about 30 characters), so every character
 * spent on the marker is one taken from the headline.
 */
const VIDEO_MARKER = "\u25b6";

/**
 * Marks only what will actually play.
 *
 * Not every video_url is a video: newsdata.io also returns embed pages
 * (tv.naver.com/embed/..., for instance) that Stremio can only hand to a
 * browser. Marking those with a play glyph promises a player that never
 * opens, which is exactly the complaint the marker exists to answer -- so
 * the marker is driven by the same test the stream is.
 */
function buildName(article) {
  return isPlayableVideo(article) ? `${VIDEO_MARKER} ${article.title}` : article.title;
}

/**
 * The article summary, never truncated by us.
 *
 * newsdata.io's `description` runs to a few hundred characters and is
 * already the full summary it has; the `content` field is the upsell string
 * "ONLY AVAILABLE IN PAID PLANS" on the free tier, which normalizeArticle
 * strips rather than letting it reach a user as article text.
 *
 * The video marker lives on the name, not here.
 */
function buildDescription(article) {
  return article.description || undefined;
}

/**
 * The detail page gets the summary plus a provenance line, since a news
 * item's source, byline and date are part of the story rather than
 * decoration -- and the summary alone can be a single sentence.
 */
function buildFullDescription(article) {
  const parts = [];
  if (article.description) parts.push(article.description);

  const credit = [article.sourceName, article.creator].filter(Boolean).join(" · ");
  const dated = [credit, formatReleaseInfo(article.pubDate)].filter(Boolean).join(" · ");
  if (dated) parts.push(dated);

  return parts.length ? parts.join("\n\n") : undefined;
}

/** Compact metadata for one item in a catalog grid. */
function toMetaPreview(article) {
  return {
    id: article.id,
    type: CONTENT_TYPE,
    name: buildName(article),
    poster: article.image || FALLBACK_POSTER,
    posterShape: "landscape",
    background: article.image || FALLBACK_BACKGROUND,
    logo: article.sourceIcon || undefined,
    description: buildDescription(article),
    releaseInfo: formatReleaseInfo(article.pubDate)
  };
}

/**
 * newsdata.io puts "top" on roughly half of everything it returns. It means
 * "this is in the top-stories feed" -- a feed designation, not a subject --
 * and it is usually the first entry in `category`, so showing that field
 * verbatim labelled most stories "top" and said nothing about any of them.
 */
const NON_SUBJECT_CATEGORIES = new Set(["top"]);

/**
 * Keywords describing the format or the publisher rather than the subject.
 * newsdata.io passes through whatever the outlet tagged its own article
 * with, so alongside genuinely useful terms ("artificial intelligence",
 * "gen z") come house tags like "latest news" and the outlet's own name.
 */
const GENERIC_KEYWORDS = new Set([
  "news",
  "latest news",
  "breaking news",
  "top stories",
  "top news",
  "headlines",
  "latest",
  "update",
  "updates",
  "today",
  "article",
  "articles",
  "report",
  "reports",
  "world news",
  "daily news"
]);

/** Initialisms that read wrong in title case. */
const ACRONYMS = new Set([
  "ai", "ar", "vr", "us", "uk", "eu", "un", "uae", "gdp", "ceo", "cfo", "cto",
  "ipo", "suv", "ev", "nasa", "nfl", "nba", "mlb", "nhl", "ipl", "fifa", "uefa",
  "gps", "api", "tv", "pc", "isp", "nsfw", "pdf", "cpu", "gpu", "usb", "sms",
  "url", "vpn", "ssd", "led", "hd", "ui", "ux", "faq", "diy", "hbo", "bbc",
  "cnn", "espn", "nato", "fbi", "cia", "nhs", "imf", "who", "un"
]);

/**
 * Publisher CMS fields that arrive as keywords.
 *
 * Seen live on a Vanity Fair story, whose tag row read "Locale: US |
 * Sponsored: False | Issyndicated: False | Content-Type: News" -- the
 * outlet's own internal record, not anything about the article.
 *
 * Matched on the key rather than the mere presence of a colon, because a
 * colon is perfectly ordinary in a real tag ("Dune: Part Two"). A trailing
 * boolean is caught on its own: nothing that describes a story ends in
 * ": true" or ": false".
 */
const CMS_FIELD_KEYS = new Set([
  "locale", "sponsored", "issyndicated", "syndicated", "content-type", "contenttype",
  "type", "section", "template", "site", "env", "environment", "status", "lang",
  "language", "region", "id", "uuid", "slug", "author", "byline", "published",
  "updated", "source", "channel", "platform", "vertical", "brand"
]);

function isCmsField(keyword) {
  const colon = keyword.indexOf(":");
  if (colon === -1) return false;
  const key = keyword.slice(0, colon).trim().toLowerCase();
  const value = keyword.slice(colon + 1).trim().toLowerCase();
  if (value === "true" || value === "false") return true;
  return CMS_FIELD_KEYS.has(key);
}

// A tag, not a sentence: newsdata.io keywords occasionally run to a whole
// clause ("sixth edition of mangaluru technovanza -2026"), which is useless
// in a tag row and pushes the real tags out.
const MAX_TAG_LENGTH = 28;
const MAX_TAGS = 6;
const MAX_CATEGORY_TAGS = 2;

/**
 * Above this, the category list is noise rather than classification: one
 * CNN story in a sample of 79 came back tagged with twelve categories --
 * education, tourism, health, sports, world, environment, politics,
 * entertainment, science, business and technology -- which says nothing
 * about it. A story genuinely spanning four subjects does not exist.
 */
const MAX_MEANINGFUL_CATEGORIES = 3;

/** Strip everything but letters and digits, for comparing names to tags. */
function fold(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Publisher CMS taxonomies masquerading as subjects.
 *
 * An outlet's own section slugs arrive as keywords and always come in
 * families sharing a segment -- CNN's "underscored-coffee",
 * "underscored-testing", "underscored-reviews"; Seeking Alpha's "eth-usd",
 * "btc-usd", "xzc-usd". A lone hyphenated keyword ("sci-fi") is a real tag,
 * so only repeated segments are treated as a taxonomy.
 */
function slugFamilySegments(keywords) {
  const counts = new Map();
  keywords
    .filter((k) => k.includes("-"))
    .forEach((k) => {
      new Set(k.toLowerCase().split("-")).forEach((segment) => {
        if (segment) counts.set(segment, (counts.get(segment) || 0) + 1);
      });
    });
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([segment]) => segment));
}

/**
 * Title Case: every word starts with a capital.
 *
 * newsdata.io returns keywords entirely in lower case (all 386 in a sample
 * of 102 stories), so the input is normalized rather than trusted -- an
 * upstream change to SHOUTING or mIxEd casing still renders the same way.
 * Hyphenated compounds are capitalised on both sides ("sci-fi" -> "Sci-Fi"),
 * since each part reads as its own word. Known initialisms stay fully
 * upper, because "AI" is right where "Ai" is simply wrong.
 */
function titleCaseTag(tag) {
  return tag
    .toLowerCase()
    .split(/(\s+|-)/) // keep the separators so they can be re-joined as-is
    .map((part) => {
      if (!part || !part.trim() || part === "-") return part;
      if (ACRONYMS.has(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
}

/**
 * The tag row on the detail page.
 *
 * Categories come first -- they are newsdata.io's own reliable taxonomy, so
 * they get the same display names the configure page uses -- then the
 * story's own keywords, which are the genuinely specific part (present on
 * about four fifths of stories, typically three of them).
 */
function buildGenres(article) {
  const rawCategories = (
    Array.isArray(article.categories) && article.categories.length
      ? article.categories
      : [article.category]
  )
    .filter((c) => typeof c === "string" && c.trim())
    .map((c) => c.trim().toLowerCase())
    .filter((c) => !NON_SUBJECT_CATEGORIES.has(c));

  const categories =
    rawCategories.length > MAX_MEANINGFUL_CATEGORIES
      ? []
      : rawCategories.slice(0, MAX_CATEGORY_TAGS).map((c) => getTopicLabel(c) || titleCaseTag(c));

  const rawKeywords = (article.keywords || []).filter((k) => typeof k === "string").map((k) => k.trim());
  const slugSegments = slugFamilySegments(rawKeywords);
  const publisher = [fold(article.sourceName), fold(article.sourceId)].filter(Boolean);

  const keywords = rawKeywords
    .filter((k) => {
      const lower = k.toLowerCase();
      if (!k || k.length > MAX_TAG_LENGTH) return false;
      if (GENERIC_KEYWORDS.has(lower)) return false;
      if (k.includes("_")) return false; // author handles and slugs
      if (lower.includes("home page") || lower.endsWith("feed")) return false; // site navigation
      if (isCmsField(k)) return false; // the outlet's own record, not a subject
      if (publisher.some((p) => p && (p === fold(k) || p.includes(fold(k))))) return false;
      if (lower.split("-").some((segment) => slugSegments.has(segment))) return false;
      return true;
    })
    .map(titleCaseTag);

  const seen = new Set();
  const tags = [];
  for (const tag of [...categories, ...keywords]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }

  return tags.length ? tags : undefined;
}

/** Full metadata for the item detail page. */
function toFullMeta(article) {
  return {
    id: article.id,
    type: CONTENT_TYPE,
    name: buildName(article),
    poster: article.image || FALLBACK_POSTER,
    posterShape: "landscape",
    background: article.image || FALLBACK_BACKGROUND,
    logo: article.sourceIcon || undefined,
    description: buildFullDescription(article),
    releaseInfo: formatReleaseInfo(article.pubDate),
    genres: buildGenres(article),
    website: article.link,
    links: [
      { name: article.sourceName, category: "source", url: article.link },
      ...(article.creator ? [{ name: article.creator, category: "creator", url: article.link }] : [])
    ]
  };
}

// A media file Stremio's player can open directly.
const DIRECT_VIDEO = /\.(mp4|m3u8|webm|mkv|mov)(\?|#|$)/i;
const HTTPS_MP4 = /^https:\/\/.+\.mp4(\?|#|$)/i;
const YOUTUBE_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

/**
 * Turn an article's video_url into a stream Stremio can actually play.
 *
 * The distinction the addon protocol draws here is the whole point: `url`
 * is a direct video stream the player opens, `ytId` plays through the
 * built-in YouTube player, and `externalUrl` is "an external URL to the
 * video, which should be opened in a browser (webpage)". Putting a real
 * media file in `externalUrl` -- which this used to do for every video --
 * means the player is never invoked at all; the story just bounces out to a
 * browser. newsdata.io's video_url is typically a direct .mp4 over https
 * (jwplayer/CDN asset URLs), which is exactly the `url` case.
 *
 * `notWebReady` is required whenever the URL is not an https MP4, which is
 * how HLS playlists and plain-http files still play instead of failing
 * silently.
 */
/** Will Stremio's own player open this story's video? */
function isPlayableVideo(article) {
  const stream = toVideoStream(article);
  return Boolean(stream && (stream.url || stream.ytId));
}

function toVideoStream(article) {
  const url = article.videoUrl;
  if (!url || typeof url !== "string") return null;

  const youtube = YOUTUBE_ID.exec(url);
  if (youtube) {
    return { name: "Newsio", title: "Play video", description: "Play video", ytId: youtube[1] };
  }

  if (DIRECT_VIDEO.test(url)) {
    const stream = { name: "Newsio", title: "Play video", description: "Play video", url };
    if (!HTTPS_MP4.test(url)) stream.behaviorHints = { notWebReady: true };
    return stream;
  }

  // Not a media file -- a page that happens to host a video. The only
  // honest thing to do with it is hand it to a browser.
  return {
    name: "Newsio",
    title: "Open video page",
    description: "Open video page",
    externalUrl: url
  };
}

/**
 * Streams for one article.
 *
 * A playable video comes first when there is one. The article link is
 * always offered too, as an externalUrl, so reading the full story is one
 * tap away whether or not a video exists.
 */
function toStreams(article) {
  const streams = [];

  const video = toVideoStream(article);
  if (video) streams.push(video);

  const readTitle = video ? `Read full story on ${article.sourceName}` : `Read on ${article.sourceName}`;
  streams.push({
    name: "Newsio",
    title: readTitle,
    description: readTitle,
    externalUrl: article.link
  });

  return streams;
}

module.exports = {
  toMetaPreview,
  toFullMeta,
  toStreams,
  toVideoStream,
  isPlayableVideo,
  formatReleaseInfo,
  buildDescription,
  buildFullDescription,
  buildGenres,
  isCmsField,
  buildName,
  VIDEO_MARKER
};
