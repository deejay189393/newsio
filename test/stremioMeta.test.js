const {
  toMetaPreview,
  toFullMeta,
  toStreams,
  formatReleaseInfo,
  buildDescription,
  buildName,
  buildFullDescription,
  buildGenres,
  toVideoStream,
  isPlayableVideo,
  VIDEO_MARKER
} = require("../src/stremioMeta");
const { FALLBACK_POSTER, FALLBACK_BACKGROUND } = require("../src/fallbackImages");

const videoArticle = {
  id: "nd_1",
  title: "AI chips get faster",
  description: "Speedups incoming.",
  link: "https://example.com/a1",
  image: "https://example.com/a1.jpg",
  videoUrl: "https://example.com/a1.mp4",
  pubDate: "2026-09-18 10:00:00",
  sourceName: "Example News",
  sourceIcon: "https://example.com/icon.png",
  category: "technology",
  creator: "Jane Doe"
};

const textArticle = {
  id: "nd_2",
  title: "Markets rally",
  description: "Stocks jumped.",
  link: "https://example.com/a2",
  image: null,
  videoUrl: null,
  pubDate: "2026-09-19 08:00:00",
  sourceName: "Business Wire",
  sourceIcon: null,
  category: "business",
  creator: null
};

describe("formatReleaseInfo", () => {
  test("converts an upstream UTC timestamp to a plain date", () => {
    expect(formatReleaseInfo("2026-09-18 10:00:00")).toBe("2026-09-18");
  });
  test("returns undefined for missing or unparseable input", () => {
    expect(formatReleaseInfo(null)).toBeUndefined();
    expect(formatReleaseInfo("")).toBeUndefined();
    expect(formatReleaseInfo("not-a-date")).toBeUndefined();
  });
});

describe("buildDescription", () => {
  test("is the article summary, with no video tag mixed in", () => {
    expect(buildDescription(videoArticle)).toBe("Speedups incoming.");
    expect(buildDescription(textArticle)).toBe("Stocks jumped.");
  });
  test("returns undefined for an empty description", () => {
    expect(buildDescription({ description: "", videoUrl: "https://v/x.mp4" })).toBeUndefined();
    expect(buildDescription({ description: "", videoUrl: null })).toBeUndefined();
  });
});

describe("buildName — telling video stories from text stories", () => {
  test("marks a story that has a playable video", () => {
    expect(buildName(videoArticle)).toBe("\u25b6 AI chips get faster");
  });

  test("leaves a text-only story's headline untouched", () => {
    expect(buildName(textArticle)).toBe("Markets rally");
    expect(buildName(textArticle)).not.toContain(VIDEO_MARKER);
  });

  test("the marker is a single glyph, so it barely eats into a truncated title", () => {
    expect(VIDEO_MARKER).toBe("\u25b6");
    expect(VIDEO_MARKER).toHaveLength(1);
    expect(buildName(videoArticle).length).toBe(videoArticle.title.length + 2);
  });

  test("the marker leads the name, where a grid actually shows it", () => {
    expect(buildName(videoArticle).startsWith(VIDEO_MARKER + " ")).toBe(true);
  });

  // Regression: the marker used to live on the description, which a catalog
  // grid never renders -- so it was invisible exactly where it mattered.
  test("the description carries no marker, in preview or full meta", () => {
    expect(toMetaPreview(videoArticle).description).not.toContain(VIDEO_MARKER);
    expect(toMetaPreview(videoArticle).description).not.toContain("[VIDEO]");
    expect(toFullMeta(videoArticle).description).not.toContain("[VIDEO]");
  });

  test("preview and full meta agree on the name", () => {
    expect(toMetaPreview(videoArticle).name).toBe(toFullMeta(videoArticle).name);
    expect(toMetaPreview(textArticle).name).toBe(toFullMeta(textArticle).name);
  });

  // newsdata.io also returns embed pages as video_url. Marking one with a
  // play glyph promises a player that never opens -- the very complaint the
  // marker exists to answer -- so the marker tracks real playability.
  test("an embed page is not marked as playable", () => {
    const embed = { id: "nd_e", title: "Clip", videoUrl: "https://tv.naver.com/embed/105719084", link: "https://l", sourceName: "S" };
    expect(isPlayableVideo(embed)).toBe(false);
    expect(buildName(embed)).toBe("Clip");
    expect(toMetaPreview(embed).name).toBe("Clip");
  });

  test("an embed page still offers a way to reach the video", () => {
    const embed = { id: "nd_e", title: "Clip", videoUrl: "https://tv.naver.com/embed/1", link: "https://l", sourceName: "S" };
    const streams = toStreams(embed);
    expect(streams).toHaveLength(2);
    expect(streams[0].externalUrl).toBe("https://tv.naver.com/embed/1");
  });

  test.each([
    ["a direct mp4", "https://cdn.example.com/a.mp4", true],
    ["a YouTube link", "https://youtu.be/dQw4w9WgXcQ", true],
    ["an HLS playlist", "https://example.com/s.m3u8", true],
    ["an embed page", "https://tv.naver.com/embed/1", false],
    ["no video at all", null, false]
  ])("the marker on %s matches whether it plays", (_label, videoUrl, expected) => {
    const a = { title: "S", videoUrl, link: "https://l", sourceName: "S" };
    expect(isPlayableVideo(a)).toBe(expected);
    expect(buildName(a).startsWith(VIDEO_MARKER)).toBe(expected);
  });

  test("a video story with no description is still marked", () => {
    const bare = { id: "nd_3", title: "Clip", description: "", videoUrl: "https://v/x.mp4", link: "https://l" };
    expect(toMetaPreview(bare).name).toBe("\u25b6 Clip");
    expect(toMetaPreview(bare).description).toBeUndefined();
  });
});

describe("toMetaPreview", () => {
  test("returns the full set of catalog-grid fields", () => {
    expect(toMetaPreview(videoArticle)).toEqual({
      id: "nd_1",
      type: "news",
      name: "\u25b6 AI chips get faster",
      poster: "https://example.com/a1.jpg",
      posterShape: "landscape",
      background: "https://example.com/a1.jpg",
      logo: "https://example.com/icon.png",
      description: "Speedups incoming.",
      releaseInfo: "2026-09-18"
    });
  });

  test("uses the inline fallback art when the story has no image", () => {
    const p = toMetaPreview(textArticle);
    expect(p.poster).toBe(FALLBACK_POSTER);
    expect(p.background).toBe(FALLBACK_BACKGROUND);
  });

  test("omits the source logo when the story has none", () => {
    expect(toMetaPreview(textArticle).logo).toBeUndefined();
  });

  test("always tags items with our custom news type", () => {
    expect(toMetaPreview(textArticle).type).toBe("news");
  });
});

describe("toFullMeta", () => {
  test("includes genre, website and a source link", () => {
    const m = toFullMeta(videoArticle);
    expect(m.genres).toEqual(["technology"]);
    expect(m.website).toBe("https://example.com/a1");
    expect(m.links[0]).toEqual({ name: "Example News", category: "source", url: "https://example.com/a1" });
  });

  test("adds a creator link only when a creator is known", () => {
    expect(toFullMeta(videoArticle).links).toHaveLength(2);
    expect(toFullMeta(videoArticle).links[1].category).toBe("creator");
    expect(toFullMeta(textArticle).links).toHaveLength(1);
  });

  test("omits genres when the story has no category", () => {
    expect(toFullMeta({ ...textArticle, category: null }).genres).toBeUndefined();
  });

  test("the detail page leads with the same summary the grid shows", () => {
    expect(toFullMeta(videoArticle).description.startsWith(toMetaPreview(videoArticle).description)).toBe(true);
  });

  test("the detail page adds a provenance line the grid has no room for", () => {
    const full = toFullMeta(videoArticle).description;
    expect(full).toContain("Example News");
    expect(full).toContain("Jane Doe");
    expect(full).toContain("2026-09-18");
  });

  test("keeps the id stable between preview and full meta", () => {
    expect(toFullMeta(videoArticle).id).toBe(toMetaPreview(videoArticle).id);
  });
});

describe("toVideoStream — what actually plays", () => {
  // The protocol distinction that matters: `url` and `ytId` are played by
  // Stremio, `externalUrl` is "an external URL to the video, which should be
  // opened in a browser". A real media file put in externalUrl never reaches
  // the player at all -- which is what this addon used to do for every video.
  const v = (videoUrl) => toVideoStream({ videoUrl });

  test("a direct https mp4 becomes a playable url stream", () => {
    const s = v("https://cdn.jwplayer.com/videos/abc.mp4");
    expect(s.url).toBe("https://cdn.jwplayer.com/videos/abc.mp4");
    expect(s.externalUrl).toBeUndefined();
    expect(s.behaviorHints).toBeUndefined();
  });

  test.each([
    ["an HLS playlist", "https://example.com/live/stream.m3u8"],
    ["a webm file", "https://example.com/clip.webm"],
    ["a plain-http mp4", "http://example.com/clip.mp4"],
    ["an mkv file", "https://example.com/clip.mkv"],
    ["a mov file", "https://example.com/clip.mov"]
  ])("%s plays as a url, flagged notWebReady", (_label, url) => {
    const s = v(url);
    expect(s.url).toBe(url);
    expect(s.behaviorHints).toEqual({ notWebReady: true });
  });

  test("a media url with a query string is still recognised", () => {
    expect(v("https://cdn.example.com/a.mp4?token=xyz").url).toBe("https://cdn.example.com/a.mp4?token=xyz");
    expect(v("https://cdn.example.com/a.mp4?token=xyz").behaviorHints).toBeUndefined();
  });

  test.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"]
  ])("%s plays through the built-in YouTube player", (url, id) => {
    const s = v(url);
    expect(s.ytId).toBe(id);
    expect(s.url).toBeUndefined();
    expect(s.externalUrl).toBeUndefined();
  });

  test("a page that merely hosts a video falls back to opening a browser", () => {
    const s = v("https://example.com/news/story-with-video");
    expect(s.externalUrl).toBe("https://example.com/news/story-with-video");
    expect(s.url).toBeUndefined();
    expect(s.ytId).toBeUndefined();
  });

  test.each([[null], [undefined], [""], [42]])("%p yields no video stream", (videoUrl) => {
    expect(toVideoStream({ videoUrl })).toBeNull();
  });
});

describe("toStreams", () => {
  test("a video story offers the playable video first, then the article", () => {
    const s = toStreams(videoArticle);
    expect(s).toHaveLength(2);
    expect(s[0].url).toBe("https://example.com/a1.mp4");
    expect(s[0].externalUrl).toBeUndefined();
    expect(s[0].title).toContain("Play video");
    expect(s[1].externalUrl).toBe("https://example.com/a1");
    expect(s[1].title).toBe("Read full story on Example News");
  });

  test("a text story offers exactly one read-article stream", () => {
    const s = toStreams(textArticle);
    expect(s).toHaveLength(1);
    expect(s[0].externalUrl).toBe("https://example.com/a2");
    expect(s[0].title).toBe("Read on Business Wire");
  });

  test("every stream is branded Newsio and points somewhere", () => {
    [...toStreams(videoArticle), ...toStreams(textArticle)].forEach((s) => {
      expect(s.name).toBe("Newsio");
      expect(Boolean(s.url || s.ytId || s.externalUrl)).toBe(true);
    });
  });

  test("streams carry both title and description, for old and new clients", () => {
    toStreams(videoArticle).forEach((s) => {
      expect(typeof s.title).toBe("string");
      expect(s.description).toBe(s.title);
    });
  });

  test("the article link is always an externalUrl -- it is a webpage", () => {
    expect(toStreams(videoArticle)[1].externalUrl).toBe(videoArticle.link);
    expect(toStreams(videoArticle)[1].url).toBeUndefined();
  });

  test("the stream list reflects exactly whether a video URL exists for that id", () => {
    expect(toStreams({ ...textArticle, videoUrl: "https://v/x.mp4" })).toHaveLength(2);
    expect(toStreams({ ...videoArticle, videoUrl: null })).toHaveLength(1);
  });
});

describe("buildGenres", () => {
  test("leads with the category, then the story's own keywords", () => {
    expect(buildGenres({ category: "technology", keywords: ["chips", "ai"] })).toEqual([
      "technology",
      "chips",
      "ai"
    ]);
  });

  test("de-duplicates and caps the tag row", () => {
    expect(buildGenres({ category: "tech", keywords: ["tech", "tech"] })).toEqual(["tech"]);
    expect(buildGenres({ category: "a", keywords: ["b", "c", "d", "e", "f", "g", "h"] })).toHaveLength(6);
  });

  test("drops blanks and non-strings", () => {
    expect(buildGenres({ category: null, keywords: ["  ", 5, "ok"] })).toEqual(["ok"]);
  });

  test("is undefined when a story has no tags at all", () => {
    expect(buildGenres({ category: null, keywords: [] })).toBeUndefined();
    expect(buildGenres({})).toBeUndefined();
  });
});

describe("buildFullDescription", () => {
  test("is the summary plus a source / byline / date line", () => {
    expect(buildFullDescription(videoArticle)).toBe(
      "Speedups incoming.\n\nExample News · Jane Doe · 2026-09-18"
    );
  });

  test("omits the byline when the story has no author", () => {
    expect(buildFullDescription(textArticle)).toBe("Stocks jumped.\n\nBusiness Wire · 2026-09-19");
  });

  test("still gives a provenance line when there is no summary", () => {
    expect(buildFullDescription({ description: "", sourceName: "Src", pubDate: "2026-09-18 10:00:00" })).toBe(
      "Src · 2026-09-18"
    );
  });

  test("is undefined when there is nothing at all to say", () => {
    expect(buildFullDescription({})).toBeUndefined();
  });

  test("does not truncate a long summary", () => {
    const long = "y".repeat(900);
    expect(buildFullDescription({ description: long })).toBe(long);
  });
});
