const { toMetaPreview, toFullMeta, toStreams, formatReleaseInfo, buildDescription } = require("../src/stremioMeta");
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
  test("prefixes [VIDEO] only when a video exists", () => {
    expect(buildDescription(videoArticle)).toBe("[VIDEO] Speedups incoming.");
    expect(buildDescription(textArticle)).toBe("Stocks jumped.");
  });
  test("still tags a video story that has no description text", () => {
    expect(buildDescription({ description: "", videoUrl: "https://v/x.mp4" })).toBe("[VIDEO]");
  });
  test("returns undefined for an empty text-only description", () => {
    expect(buildDescription({ description: "", videoUrl: null })).toBeUndefined();
  });
});

describe("toMetaPreview", () => {
  test("returns the full set of catalog-grid fields", () => {
    expect(toMetaPreview(videoArticle)).toEqual({
      id: "nd_1",
      type: "news",
      name: "AI chips get faster",
      poster: "https://example.com/a1.jpg",
      posterShape: "landscape",
      background: "https://example.com/a1.jpg",
      logo: "https://example.com/icon.png",
      description: "[VIDEO] Speedups incoming.",
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

  test("carries the same [VIDEO] tag as the preview, so the detail page agrees with the grid", () => {
    expect(toFullMeta(videoArticle).description).toBe(toMetaPreview(videoArticle).description);
  });

  test("keeps the id stable between preview and full meta", () => {
    expect(toFullMeta(videoArticle).id).toBe(toMetaPreview(videoArticle).id);
  });
});

describe("toStreams", () => {
  test("a video story offers the video first, then the article", () => {
    const s = toStreams(videoArticle);
    expect(s).toHaveLength(2);
    expect(s[0].externalUrl).toBe("https://example.com/a1.mp4");
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

  test("every stream is branded Newsio and carries a URL", () => {
    [...toStreams(videoArticle), ...toStreams(textArticle)].forEach((s) => {
      expect(s.name).toBe("Newsio");
      expect(typeof s.externalUrl).toBe("string");
    });
  });

  test("the stream list reflects exactly whether a video URL exists for that id", () => {
    expect(toStreams({ ...textArticle, videoUrl: "https://v/x.mp4" })).toHaveLength(2);
    expect(toStreams({ ...videoArticle, videoUrl: null })).toHaveLength(1);
  });
});
