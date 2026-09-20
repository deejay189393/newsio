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
 * Prefix the description with "[VIDEO]" when the story has a real video
 * attached, so the user can tell at a glance -- in the catalog grid and on
 * the detail page -- whether pressing play will actually play something,
 * versus just opening the article in a browser.
 */
function buildDescription(article) {
  const base = article.description || "";
  if (article.videoUrl) return `[VIDEO] ${base}`.trim();
  return base || undefined;
}

/** Compact metadata for one item in a catalog grid. */
function toMetaPreview(article) {
  return {
    id: article.id,
    type: CONTENT_TYPE,
    name: article.title,
    poster: article.image || FALLBACK_POSTER,
    posterShape: "landscape",
    background: article.image || FALLBACK_BACKGROUND,
    logo: article.sourceIcon || undefined,
    description: buildDescription(article),
    releaseInfo: formatReleaseInfo(article.pubDate)
  };
}

/** Full metadata for the item detail page. */
function toFullMeta(article) {
  return {
    id: article.id,
    type: CONTENT_TYPE,
    name: article.title,
    poster: article.image || FALLBACK_POSTER,
    posterShape: "landscape",
    background: article.image || FALLBACK_BACKGROUND,
    logo: article.sourceIcon || undefined,
    description: buildDescription(article),
    releaseInfo: formatReleaseInfo(article.pubDate),
    genres: article.category ? [article.category] : undefined,
    website: article.link,
    links: [
      { name: article.sourceName, category: "source", url: article.link },
      ...(article.creator ? [{ name: article.creator, category: "creator", url: article.link }] : [])
    ]
  };
}

/**
 * Streams for one article.
 *
 * If newsdata.io gave us a video_url, that goes first -- it's the thing
 * that actually plays. The article link is always offered as well (as an
 * externalUrl, which Stremio opens in the user's browser), so reading the
 * full story is one tap away whether or not a video exists.
 */
function toStreams(article) {
  const streams = [];

  if (article.videoUrl) {
    streams.push({
      name: "Newsio",
      title: "▶ Play video",
      externalUrl: article.videoUrl
    });
  }

  streams.push({
    name: "Newsio",
    title: article.videoUrl ? `Read full story on ${article.sourceName}` : `Read on ${article.sourceName}`,
    externalUrl: article.link
  });

  return streams;
}

module.exports = { toMetaPreview, toFullMeta, toStreams, formatReleaseInfo, buildDescription };
