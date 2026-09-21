const { CONTENT_TYPE } = require("./manifest");
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
 * Genres double as the detail page's tag row, so the story's own keywords
 * ride along with its category rather than being thrown away.
 */
function buildGenres(article) {
  const genres = [article.category, ...(article.keywords || [])]
    .filter((g) => typeof g === "string" && g.trim())
    .map((g) => g.trim());
  const unique = [...new Set(genres)];
  return unique.length ? unique.slice(0, 6) : undefined;
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
  buildName,
  VIDEO_MARKER
};
