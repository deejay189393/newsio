const {
  toMetaPreview,
  toFullMeta,
  toStreams,
  formatReleaseInfo,
  buildDescription,
  buildName,
  buildFullDescription,
  buildGenres,
  isCmsField,
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
    expect(m.genres).toEqual(["Technology"]);
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

describe("buildGenres — the detail page tag row", () => {
  const g = (article) => buildGenres(article);

  // Regression: newsdata.io puts "top" on roughly half of everything, and it
  // is usually category[0] -- so serving that field verbatim labelled most
  // stories "top" and told the reader nothing.
  describe('the "top" pseudo-category', () => {
    test('is never shown, even when it is the only category', () => {
      expect(g({ categories: ["top"], keywords: [] })).toBeUndefined();
    });

    test("is dropped in favour of the real subject beside it", () => {
      expect(g({ categories: ["top", "technology"], keywords: [] })).toEqual(["Technology"]);
    });

    test("is dropped wherever it appears in the list", () => {
      expect(g({ categories: ["politics", "top"], keywords: [] })).toEqual(["Politics"]);
    });

    test("never survives into the rendered meta", () => {
      const meta = toFullMeta({ ...textArticle, categories: ["top", "business"], keywords: ["markets"] });
      expect(meta.genres).not.toContain("top");
      expect(meta.genres).toContain("Finance & Business");
    });
  });

  describe("categories", () => {
    test("use the display names the configure page uses", () => {
      expect(g({ categories: ["business"], keywords: [] })).toEqual(["Finance & Business"]);
      expect(g({ categories: ["tourism"], keywords: [] })).toEqual(["Tourism & Travel"]);
    });

    test("an unknown category is still shown, title-cased", () => {
      expect(g({ categories: ["nanotech"], keywords: [] })).toEqual(["Nanotech"]);
    });

    test("are capped, so they cannot crowd out the specific tags", () => {
      const out = g({ categories: ["technology", "science", "health"], keywords: ["chips"] });
      expect(out).toEqual(["Technology", "Science", "Chips"]);
    });

    // A real CNN story came back tagged with twelve categories.
    test("a spray-tagged story shows no categories at all", () => {
      const sprayed = {
        categories: [
          "education", "tourism", "health", "sports", "world", "environment",
          "politics", "entertainment", "science", "top", "business", "technology"
        ],
        keywords: ["coffee"]
      };
      expect(g(sprayed)).toEqual(["Coffee"]);
    });

    test("falls back to the single category field when the list is absent", () => {
      expect(g({ category: "science", keywords: [] })).toEqual(["Science"]);
    });
  });

  describe("keywords", () => {
    test("are the specific part, and follow the categories", () => {
      expect(g({ categories: ["top", "technology"], keywords: ["artificial intelligence", "gen z"] })).toEqual([
        "Technology",
        "Artificial Intelligence",
        "Gen Z"
      ]);
    });

    test.each([
      "news", "latest news", "breaking news", "top stories", "headlines", "world news"
    ])("the format tag %p is dropped", (kw) => {
      expect(g({ categories: [], keywords: [kw, "porsche"] })).toEqual(["Porsche"]);
    });

    test("a whole clause is not a tag", () => {
      const clause = "sixth edition of mangaluru technovanza -2026";
      expect(g({ categories: [], keywords: [clause, "startups"] })).toEqual(["Startups"]);
    });

    test("an author handle or slug with an underscore is dropped", () => {
      expect(g({ categories: [], keywords: ["yashu_crypto", "avalanche"] })).toEqual(["Avalanche"]);
    });

    test.each(["home page 3", "yahoo feed"])("site navigation tag %p is dropped", (kw) => {
      expect(g({ categories: [], keywords: [kw, "markets"] })).toEqual(["Markets"]);
    });

    test("the publisher's own name is not a subject", () => {
      expect(g({ sourceName: "Mail Online", sourceId: "dailymail", categories: [], keywords: ["dailymail", "royals"] })).toEqual(
        ["Royals"]
      );
      expect(g({ sourceName: "Fox News", categories: [], keywords: ["fox news", "senate"] })).toEqual(["Senate"]);
    });

    // CNN's "underscored-*" section slugs, Seeking Alpha's "*-usd" tickers.
    test("a CMS slug family is recognised and dropped whole", () => {
      const cnn = ["underscored-coffee", "underscored-testing", "underscored-reviews", "espresso"];
      expect(g({ categories: [], keywords: cnn })).toEqual(["Espresso"]);
    });

    test("a family sharing a trailing segment is dropped too", () => {
      expect(g({ categories: [], keywords: ["eth-usd", "btc-usd", "xzc-usd", "regulation"] })).toEqual([
        "Regulation"
      ]);
    });

    test("a hyphenated keyword with an empty segment is handled", () => {
      expect(buildGenres({ categories: [], keywords: ["-lead-", "markets"] })).toEqual(["-Lead-", "Markets"]);
    });

    test("a lone hyphenated keyword is a real tag and survives", () => {
      expect(g({ categories: [], keywords: ["sci-fi", "apple tv"] })).toEqual(["Sci-Fi", "Apple TV"]);
    });
  });

  describe("presentation", () => {
    test("tags are title-cased for display", () => {
      expect(g({ categories: [], keywords: ["jensen huang", "digital wallet"] })).toEqual([
        "Jensen Huang",
        "Digital Wallet"
      ]);
    });

    test.each([
      ["ai", "AI"],
      ["us", "US"],
      ["nasa", "NASA"],
      ["fifa", "FIFA"],
      ["ev", "EV"],
      ["isp", "ISP"],
      ["nsfw", "NSFW"],
      ["pdf", "PDF"],
      ["gpu", "GPU"]
    ])("the initialism %p renders as %p", (raw, shown) => {
      expect(g({ categories: [], keywords: [raw] })).toEqual([shown]);
    });

    // newsdata.io returns keywords entirely lower case, so the input is
    // normalised rather than trusted: an upstream change in casing must not
    // leak a SHOUTING or half-cased tag into the row.
    test.each([
      ["artificial intelligence", "Artificial Intelligence"],
      ["ARTIFICIAL INTELLIGENCE", "Artificial Intelligence"],
      ["Artificial Intelligence", "Artificial Intelligence"],
      ["aRtIfIcIaL iNtElLiGeNcE", "Artificial Intelligence"],
      ["iPhone", "Iphone"],
      ["GEN Z", "Gen Z"]
    ])("%p renders as %p whatever casing it arrives in", (raw, shown) => {
      expect(g({ categories: [], keywords: [raw] })).toEqual([shown]);
    });

    test.each([
      ["sci-fi", "Sci-Fi"],
      ["e-bus", "E-Bus"],
      ["multi-asset trading", "Multi-Asset Trading"],
      ["co-op action survival", "Co-Op Action Survival"]
    ])("a hyphenated compound %p capitalises both sides: %p", (raw, shown) => {
      expect(g({ categories: [], keywords: [raw] })).toEqual([shown]);
    });

    test("every word of every tag starts with a capital", () => {
      const tags = g({
        categories: ["top", "technology"],
        keywords: ["jensen huang", "gen z", "sci-fi", "child custody", "2026 elections"]
      });
      tags.forEach((tag) => {
        tag.split(/[\s-]+/).forEach((word) => {
          if (!/^[a-zA-Z]/.test(word)) return; // numbers and symbols have no case
          expect(word[0]).toBe(word[0].toUpperCase());
        });
      });
    });

    // Seen live on a Vanity Fair story, whose whole tag row was the
    // outlet's internal record rather than anything about the article.
    describe("publisher CMS fields", () => {
      test.each([
        "locale: us",
        "sponsored: false",
        "issyndicated: false",
        "content-type: news",
        "section: culture",
        "template: standard",
        "status: published",
        "lang: en"
      ])("drops %p", (kw) => {
        expect(isCmsField(kw)).toBe(true);
        expect(g({ categories: [], keywords: [kw, "red carpet"] })).toEqual(["Red Carpet"]);
      });

      test("any key with a boolean value is metadata, whatever it is called", () => {
        expect(isCmsField("paywalled: true")).toBe(true);
        expect(isCmsField("exclusive: FALSE")).toBe(true);
      });

      test("the whole live row collapses to the real tags", () => {
        expect(
          g({
            categories: ["entertainment"],
            keywords: [
              "locale: us",
              "sponsored: false",
              "issyndicated: false",
              "content-type: news",
              "lucas museum",
              "red carpet"
            ]
          })
        ).toEqual(["Entertainment", "Lucas Museum", "Red Carpet"]);
      });

      // A colon is ordinary in a real tag, so the key is what is matched.
      test.each([
        "dune: part two",
        "star wars: andor",
        "breaking bad: el camino",
        "the last of us: season 2"
      ])("keeps the real tag %p", (kw) => {
        expect(isCmsField(kw)).toBe(false);
        expect(g({ categories: [], keywords: [kw] })).toHaveLength(1);
      });

      test("a keyword with no colon is never treated as metadata", () => {
        expect(isCmsField("red carpet")).toBe(false);
        expect(isCmsField("")).toBe(false);
      });
    });

    test("an entity-escaped keyword renders as real characters", () => {
      // Seen live: "Telco &amp; Isp".
      const article = { categories: [], keywords: ["telco & isp"] };
      expect(g(article)).toEqual(["Telco & ISP"]);
    });

    test("category labels keep their own punctuation and casing", () => {
      expect(g({ categories: ["business"], keywords: [] })).toEqual(["Finance & Business"]);
      expect(g({ categories: ["tourism"], keywords: [] })).toEqual(["Tourism & Travel"]);
    });

    test("de-duplicates case-insensitively across categories and keywords", () => {
      expect(g({ categories: ["technology"], keywords: ["Technology", "technology", "chips"] })).toEqual([
        "Technology",
        "Chips"
      ]);
    });

    test("the row is capped at six tags", () => {
      const many = ["a", "b", "c", "d", "e", "f", "g", "h"];
      expect(g({ categories: ["technology"], keywords: many })).toHaveLength(6);
    });
  });

  describe("nothing to show", () => {
    test.each([
      ["no tags at all", { categories: [], keywords: [] }],
      ["an empty object", {}],
      ["only blanks and non-strings", { categories: [], keywords: ["  ", 5, null] }],
      ["only the top pseudo-category", { categories: ["top"], keywords: [] }],
      ["only generic keywords", { categories: [], keywords: ["news", "latest news"] }]
    ])("%s yields undefined rather than an empty row", (_label, article) => {
      expect(g(article)).toBeUndefined();
    });
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
