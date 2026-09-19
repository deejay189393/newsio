const { CONTENT_TYPE } = require("./manifest");

function formatReleaseInfo(pubDate) {
  if (!pubDate) return undefined;
  const d = new Date(pubDate.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

// Prefix the description with "[VIDEO]" whenever the article has an actual
// video attached, so the user can tell at a glance -- in the catalog grid
// and on the detail page -- whether pressing play will actually play
// something, versus just opening the article link in a browser.
function buildDescription(article) {
  const base = article.description || "";
  if (article.videoUrl) {
    return `[VIDEO] ${base}`.trim();
  }
  return base || undefined;
}

function toMetaPreview(article) {
  return {
    id: article.id,
    type: CONTENT_TYPE,
    name: article.title,
    poster: article.image || undefined,
    posterShape: "landscape",
    background: article.image || undefined,
    logo: article.sourceIcon || undefined,
    description: buildDescription(article),
    releaseInfo: formatReleaseInfo(article.pubDate)
  };
}

function toFullMeta(article) {
  return {
    id: article.id,
    type: CONTENT_TYPE,
    name: article.title,
    poster: article.image || undefined,
    posterShape: "landscape",
    background: article.image || undefined,
    logo: article.sourceIcon || undefined,
    description: buildDescription(article),
    releaseInfo: formatReleaseInfo(article.pubDate),
    genres: article.category ? [article.category] : undefined,
    website: article.link,
    links: [
      {
        name: article.sourceName,
        category: "source",
        url: article.link
      },
      ...(article.creator
        ? [{ name: article.creator, category: "creator", url: article.link }]
        : [])
    ]
  };
}

// Stream list for one article. If newsdata.io gave us a video_url, offer it
// first (it's the thing that actually plays); the article link is always
// offered too, as an externalUrl, so reading the full story is one tap away
// either way.
function toStreams(article) {
  const streams = [];

  if (article.videoUrl) {
    streams.push({
      name: "Newsio",
      title: "\u25B6 Play video",
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

module.exports = { toMetaPreview, toFullMeta, toStreams };
