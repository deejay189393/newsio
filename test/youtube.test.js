const { clearAllCaches, articleCache } = require("../src/cache");
const youtube = require("../src/providers/youtube");
const { isLowQuality } = require("../src/articles");

beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

const ok = (data) => ({ ok: true, json: async () => data });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

/** A search hit, shaped as `search.list` really returns one. */
const hit = (videoId, overrides = {}) => ({
  kind: "youtube#searchResult",
  id: { kind: "youtube#video", videoId },
  snippet: {
    publishedAt: "2026-09-21T17:55:42Z",
    channelId: "UC123",
    channelTitle: "Reuters",
    title: `Story ${videoId}`,
    description: "truncated blurb…",
    thumbnails: { default: { url: `https://i.ytimg.com/vi/${videoId}/default.jpg` } },
    liveBroadcastContent: "none",
    ...overrides
  }
});

/** The same video as `videos.list` returns it: the full record. */
const detail = (videoId, overrides = {}) => ({
  id: videoId,
  snippet: {
    publishedAt: "2026-09-21T17:55:42Z",
    channelId: "UC123",
    channelTitle: "Reuters",
    title: `Story ${videoId}`,
    description: "the whole description, which search.list truncates",
    defaultAudioLanguage: "en",
    tags: ["iran", "world affairs"],
    thumbnails: {
      high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` },
      maxres: { url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` }
    },
    liveBroadcastContent: "none",
    ...(overrides.snippet || {})
  },
  contentDetails: { duration: "PT9M5S", ...(overrides.contentDetails || {}) },
  statistics: { viewCount: "51234", ...(overrides.statistics || {}) },
  status: { embeddable: true, privacyStatus: "public", ...(overrides.status || {}) }
});

/**
 * One search response plus its enrichment, in the order fetchPage issues
 * them. `videos.list` always follows the `search.list` that found the ids.
 */
function mockPage(ids, { nextPageToken = null, details } = {}) {
  const items = ids.map((id) => (typeof id === "string" ? hit(id) : id));
  const videoIds = items.map((i) => i.id.videoId);
  return [
    ok({ items, ...(nextPageToken ? { nextPageToken } : {}) }),
    ok({ items: details || videoIds.map((id) => detail(id)) })
  ];
}

function mockFetch(...responses) {
  const spy = jest.spyOn(global, "fetch");
  responses.flat().forEach((r) => spy.mockResolvedValueOnce(r));
  return spy;
}

const urlsOf = (spy) => spy.mock.calls.map(([u]) => u);
const paramsOf = (spy, i) => Object.fromEntries(new URL(spy.mock.calls[i][0]).searchParams);

describe("the request YouTube is actually sent", () => {
  test("a preset topic searches its terms inside the news category", async () => {
    const spy = mockFetch(mockPage(["aaaaaaaaaaa"]));
    await youtube.fetchPage({ apiKey: "k", topic: "technology", language: "en", skip: 0 });

    const p = paramsOf(spy, 0);
    expect(p.q).toBe("technology news");
    expect(p.videoCategoryId).toBe("25");
    expect(p.type).toBe("video");
    expect(p.part).toBe("snippet");
    expect(p.maxResults).toBe("50");
    expect(p.order).toBe("date");
    expect(p.videoDuration).toBe("medium");
    expect(p.videoEmbeddable).toBe("true");
    expect(p.relevanceLanguage).toBe("en");
    expect(p.regionCode).toBe("US");
  });

  test("a free-text search appends \"news\" and drops the category", async () => {
    // Measured live: videoCategoryId=25 strangles a narrow query, returning
    // a handful of thin clips, so the word does the constraining instead.
    const spy = mockFetch(mockPage(["aaaaaaaaaaa"]));
    await youtube.fetchPage({ apiKey: "k", query: "FIFA World Cup", language: "en", skip: 0 });

    const p = paramsOf(spy, 0);
    expect(p.q).toBe("FIFA World Cup news");
    expect(p.videoCategoryId).toBeUndefined();
  });

  test("the region follows the language", async () => {
    const spy = mockFetch(mockPage(["aaaaaaaaaaa"]));
    await youtube.fetchPage({ apiKey: "k", topic: "world", language: "ja", skip: 0 });
    expect(paramsOf(spy, 0).regionCode).toBe("JP");
  });

  test("enrichment asks for every id from the search in one call", async () => {
    const spy = mockFetch(mockPage(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]));
    await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });

    expect(urlsOf(spy)[1]).toContain("/videos?");
    const p = paramsOf(spy, 1);
    expect(p.id).toBe("aaaaaaaaaaa,bbbbbbbbbbb,ccccccccccc");
    expect(p.part).toBe("snippet,contentDetails,statistics,status");
  });

  test("a search that returns nothing skips the enrichment call entirely", async () => {
    const spy = mockFetch([ok({ items: [] })]);
    const page = await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });
    expect(page.articles).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("no key fails before any request is made", async () => {
    const spy = jest.spyOn(global, "fetch");
    await expect(youtube.fetchPage({ topic: "world", language: "en", skip: 0 })).rejects.toMatchObject({
      status: 401
    });
    expect(spy).not.toHaveBeenCalled();
  });

  test("an unmapped topic is refused rather than searched for blindly", async () => {
    await expect(
      youtube.fetchPage({ apiKey: "k", topic: "nonsense", language: "en", skip: 0 })
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("normalising a video into an article", () => {
  test("takes the full description from videos.list, not the truncated one", async () => {
    mockFetch(mockPage(["aaaaaaaaaaa"]));
    const page = await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });
    expect(page.articles[0].description).toBe("the whole description, which search.list truncates");
  });

  test("the video is addressed as a watch URL, which stremioMeta turns into a ytId", () => {
    const a = youtube.normalize(hit("dQw4w9WgXcQ"), detail("dQw4w9WgXcQ"));
    expect(a.id).toBe("yt_dQw4w9WgXcQ");
    expect(a.link).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(a.videoUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  test("the channel is the source, and its tags become keywords", () => {
    const a = youtube.normalize(hit("aaaaaaaaaaa"), detail("aaaaaaaaaaa"));
    expect(a.sourceName).toBe("Reuters");
    expect(a.sourceId).toBe("UC123");
    expect(a.keywords).toEqual(["iran", "world affairs"]);
    expect(a.provider).toBe("youtube");
  });

  test("falls back to the search snippet when enrichment did not return the video", () => {
    const a = youtube.normalize(hit("aaaaaaaaaaa"), undefined);
    expect(a.title).toBe("Story aaaaaaaaaaa");
    expect(a.sourceName).toBe("Reuters");
    expect(a.pubDate).toBe("2026-09-21T17:55:42Z");
    expect(a.image).toBe("https://i.ytimg.com/vi/aaaaaaaaaaa/default.jpg");
    expect(a.duration).toBeNull();
    expect(a.viewCount).toBeNull();
  });

  test("a title-less video still yields an article", () => {
    const a = youtube.normalize(hit("aaaaaaaaaaa", { title: "" }), undefined);
    expect(a.title).toBe("Untitled");
  });

  test("entities in titles are decoded once, at the boundary", () => {
    const a = youtube.normalize(hit("aaaaaaaaaaa", { title: "What&#39;s behind Big Tech" }), undefined);
    expect(a.title).toBe("What's behind Big Tech");
  });

  test("non-string tags are discarded rather than rendered", () => {
    const d = detail("aaaaaaaaaaa", { snippet: { tags: ["real", 42, null, "  "] } });
    expect(youtube.normalize(hit("aaaaaaaaaaa"), d).keywords).toEqual(["real"]);
  });

  test("a video with no tags at all has no keywords", () => {
    const d = detail("aaaaaaaaaaa", { snippet: { tags: undefined } });
    expect(youtube.normalize(hit("aaaaaaaaaaa"), d).keywords).toEqual([]);
  });
});

describe("when enrichment comes back thin", () => {
  // videos.list can answer with a record missing the fields search.list did
  // supply -- the search snippet is the floor, never discarded.
  const sparse = (id) => ({ id, snippet: {}, contentDetails: {}, statistics: {}, status: {} });

  test("each missing field falls back to the search snippet", () => {
    const a = youtube.normalize(hit("aaaaaaaaaaa"), sparse("aaaaaaaaaaa"));
    expect(a.title).toBe("Story aaaaaaaaaaa");
    expect(a.sourceName).toBe("Reuters");
    expect(a.sourceId).toBe("UC123");
    expect(a.pubDate).toBe("2026-09-21T17:55:42Z");
    expect(a.image).toBe("https://i.ytimg.com/vi/aaaaaaaaaaa/default.jpg");
    expect(a.liveBroadcast).toBe("none");
  });

  test("with neither side supplying them, the article still holds together", () => {
    const bare = { id: { videoId: "aaaaaaaaaaa" }, snippet: {} };
    const a = youtube.normalize(bare, sparse("aaaaaaaaaaa"));
    expect(a.title).toBe("Untitled");
    expect(a.sourceName).toBe("YouTube");
    expect(a.sourceId).toBeNull();
    expect(a.pubDate).toBeNull();
    expect(a.image).toBeNull();
    expect(a.liveBroadcast).toBe("none");
    expect(a.link).toBe("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  });

  test("an item with no snippet on either side does not crash", () => {
    const a = youtube.normalize({ id: { videoId: "aaaaaaaaaaa" } }, undefined);
    expect(a.id).toBe("yt_aaaaaaaaaaa");
    expect(a.title).toBe("Untitled");
  });

  test("a videos.list reply carrying no items leaves every video unenriched", async () => {
    mockFetch([ok({ items: [hit("aaaaaaaaaaa")] }), ok({})]);
    const page = await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });
    // The search snippet alone still describes it, and nothing is known
    // against it, so it is kept rather than thrown away.
    expect(page.articles.map((a) => a.title)).toEqual(["Story aaaaaaaaaaa"]);
  });

  test("a search reply carrying no items list is an empty page, not a crash", async () => {
    mockFetch([ok({ kind: "youtube#searchListResponse" })]);
    const page = await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });
    expect(page.articles).toEqual([]);
  });
});

describe("thumbnails", () => {
  test("the largest size offered wins", () => {
    expect(
      youtube.bestThumbnail({
        default: { url: "d" },
        high: { url: "h" },
        standard: { url: "s" },
        maxres: { url: "m" }
      })
    ).toBe("m");
    expect(youtube.bestThumbnail({ default: { url: "d" }, high: { url: "h" } })).toBe("h");
    expect(youtube.bestThumbnail({ default: { url: "d" } })).toBe("d");
  });

  test("a missing or empty set is no image rather than a broken one", () => {
    expect(youtube.bestThumbnail(undefined)).toBeNull();
    expect(youtube.bestThumbnail({})).toBeNull();
    expect(youtube.bestThumbnail({ high: {} })).toBeNull();
  });
});

describe("durations", () => {
  test.each([
    ["PT9M5S", 545, "9 min"],
    ["PT1H2M3S", 3723, "1h 2m"],
    ["PT45S", 45, "1 min"],
    ["PT11M1S", 661, "11 min"],
    ["P1DT2H", 93600, "26h 0m"]
  ])("%p is %p seconds, shown as %p", (iso, seconds, shown) => {
    expect(youtube.durationToSeconds(iso)).toBe(seconds);
    expect(youtube.formatDuration(iso)).toBe(shown);
  });

  test("an unparseable or zero duration is omitted, not shown as 0", () => {
    expect(youtube.durationToSeconds("nonsense")).toBeNull();
    expect(youtube.durationToSeconds(undefined)).toBeNull();
    expect(youtube.formatDuration("nonsense")).toBeNull();
    expect(youtube.formatDuration("PT0S")).toBeNull();
  });
});

describe("language tags", () => {
  test.each([
    ["en", "en"],
    ["en-IN", "en"],
    ["en-GB", "en"],
    ["EN-us", "en"],
    ["hi", "hi"]
  ])("%p is the %p language", (tag, primary) => {
    expect(youtube.primaryLanguage(tag)).toBe(primary);
  });

  test("a missing tag is no language rather than a crash", () => {
    expect(youtube.primaryLanguage(undefined)).toBe("");
    expect(youtube.primaryLanguage(null)).toBe("");
    expect(youtube.primaryLanguage(42)).toBe("");
  });
});

describe("which videos are kept", () => {
  const article = (over = {}) => ({
    embeddable: true,
    liveBroadcast: "none",
    language: "en",
    viewCount: 50000,
    ...over
  });

  test("a good video is kept", () => {
    expect(youtube.exclusionReason(article(), "en")).toBeNull();
  });

  test("a non-embeddable video is dropped: ytId could never play it", () => {
    expect(youtube.exclusionReason(article({ embeddable: false }), "en")).toBe("not embeddable");
  });

  test("a premiere that has not aired is dropped, but a live broadcast is kept", () => {
    expect(youtube.exclusionReason(article({ liveBroadcast: "upcoming" }), "en")).toBe("not broadcast yet");
    expect(youtube.exclusionReason(article({ liveBroadcast: "live" }), "en")).toBeNull();
  });

  test("audio in another language is dropped, since relevanceLanguage is only a hint", () => {
    expect(youtube.exclusionReason(article({ language: "hi" }), "en")).toBe("hi audio");
    expect(youtube.exclusionReason(article({ language: "bn" }), "en")).toBe("bn audio");
  });

  test("a regional variant of the wanted language is kept", () => {
    // en-IN normalises to en upstream of here; NDTV Profit is not junk.
    expect(youtube.exclusionReason(article({ language: "en" }), "en")).toBeNull();
  });

  test("an unset language is kept: absent is not wrong", () => {
    expect(youtube.exclusionReason(article({ language: "" }), "en")).toBeNull();
  });

  test("everything passes when no language was asked for", () => {
    expect(youtube.exclusionReason(article({ language: "hi" }), "")).toBeNull();
  });

  test("a video almost nobody has watched is dropped", () => {
    // Measured: impersonator and auto-generated channels sat at 1-3 views
    // beside Bloomberg's 241,766 on the same query.
    expect(youtube.exclusionReason(article({ viewCount: 3 }), "en")).toBe("too few views");
    expect(youtube.exclusionReason(article({ viewCount: youtube.MIN_VIEW_COUNT - 1 }), "en")).toBe(
      "too few views"
    );
    expect(youtube.exclusionReason(article({ viewCount: youtube.MIN_VIEW_COUNT }), "en")).toBeNull();
  });

  test("an unknown view count is not held against the video", () => {
    expect(youtube.exclusionReason(article({ viewCount: null }), "en")).toBeNull();
  });

  test("excluded videos are marked, not removed, so the page keeps its size", async () => {
    const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];
    mockFetch(
      mockPage(ids, {
        details: [
          detail("aaaaaaaaaaa"),
          detail("bbbbbbbbbbb", { statistics: { viewCount: "2" } }),
          detail("ccccccccccc", { snippet: { defaultAudioLanguage: "hi" } })
        ]
      })
    );
    const page = await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });

    // Only the good one survives the shared post-slice filter...
    expect(page.articles.map((a) => a.id)).toEqual(["yt_aaaaaaaaaaa"]);
    // ...and only it was cached for /meta and /stream.
    expect(articleCache.get("yt_aaaaaaaaaaa")).toBeTruthy();
    expect(articleCache.get("yt_bbbbbbbbbbb")).toBeUndefined();
  });

  test("the shared filter honours the provider's verdict", () => {
    expect(isLowQuality({ excluded: "too few views" })).toBe(true);
    expect(isLowQuality({ title: "x", description: "y" })).toBe(false);
  });
});

describe("paging through a catalog", () => {
  test("page two follows the token page one handed back", async () => {
    const spy = mockFetch(
      mockPage(Array.from({ length: 50 }, (_, i) => `a${String(i).padStart(10, "0")}`), {
        nextPageToken: "TOKEN2"
      }),
      mockPage(Array.from({ length: 50 }, (_, i) => `b${String(i).padStart(10, "0")}`))
    );

    await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });
    await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 60 });

    // Calls 0/1 are page one's search+enrich; 2/3 are page two's.
    expect(paramsOf(spy, 0).pageToken).toBeUndefined();
    expect(paramsOf(spy, 2).pageToken).toBe("TOKEN2");
  });

  test("a fetched page is held for an hour, because the daily allowance is 100", async () => {
    // The shared ten-minute default suits an API measured in thousands of
    // calls a day. Seven topics at ten minutes is 42 searches an hour and
    // the whole allowance inside three hours -- which is how it ran out.
    expect(youtube.PAGE_CACHE_TTL_MS).toBe(60 * 60 * 1000);

    const spy = mockFetch(mockPage(["aaaaaaaaaaa"]));
    const args = { apiKey: "k", topic: "world", language: "en", skip: 0 };
    await youtube.fetchPage(args);
    expect(spy).toHaveBeenCalledTimes(2); // one search, one enrichment

    // Half an hour later -- past the shared default -- still no new search.
    const realNow = Date.now;
    Date.now = () => realNow() + 30 * 60 * 1000;
    try {
      const again = await youtube.fetchPage(args);
      expect(again.articles).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  test("a page already fetched is served from cache, spending no quota", async () => {
    const spy = mockFetch(mockPage(["aaaaaaaaaaa"], { nextPageToken: "T2" }));
    await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });
    await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });
    expect(spy).toHaveBeenCalledTimes(2); // the first pair only
  });

  test("the end of the feed is the end, not a silent restart from page one", async () => {
    mockFetch(mockPage(["aaaaaaaaaaa"]));
    const page = await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });
    expect(page.hasMore).toBe(false);

    // No further request: the stored null cursor says there is nothing after.
    const page2 = await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 50 });
    expect(page2.articles).toEqual([]);
    expect(page2.hasMore).toBe(false);
  });

  test("a jump too deep to reach is reported as truncated rather than walked", async () => {
    mockFetch(mockPage(["aaaaaaaaaaa"], { nextPageToken: "T2" }));
    const page = await youtube.fetchPage({
      apiKey: "k",
      topic: "world",
      language: "en",
      skip: youtube.UPSTREAM_PAGE_SIZE * (youtube.MAX_PAGE_WALK + 2)
    });
    expect(page.truncated).toBe(true);
    expect(page.articles).toEqual([]);
  });

  test("a feed that ends mid-walk yields nothing rather than an earlier page again", async () => {
    mockFetch(
      mockPage(["aaaaaaaaaaa"], { nextPageToken: "T2" }),
      mockPage(["bbbbbbbbbbb"]) // no token: the walk cannot reach page 2
    );
    const page = await youtube.fetchPage({
      apiKey: "k",
      topic: "world",
      language: "en",
      skip: youtube.UPSTREAM_PAGE_SIZE * 2
    });
    expect(page.articles).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  test("two different topics do not share a cache entry", async () => {
    const spy = mockFetch(mockPage(["aaaaaaaaaaa"]), mockPage(["bbbbbbbbbbb"]));
    await youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 });
    await youtube.fetchPage({ apiKey: "k", topic: "business", language: "en", skip: 0 });
    expect(spy).toHaveBeenCalledTimes(4);
  });
});

describe("errors, mapped onto what the failover engine does next", () => {
  test.each([
    [403, "quotaExceeded", 403],
    [403, "dailyLimitExceeded", 403],
    [429, "rateLimitExceeded", 429],
    [403, "userRateLimitExceeded", 429],
    [400, "keyInvalid", 401],
    [400, "badRequest", 401],
    [403, "forbidden", 401]
  ])("HTTP %p/%p surfaces as %p", async (http, reason, expected) => {
    mockFetch([fail(http, { error: { message: "nope", errors: [{ reason }] } })]);
    await expect(
      youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 })
    ).rejects.toMatchObject({ status: expected });
  });

  test("a key that will never work is 401, not a retryable 400", () => {
    // A plain 400 elsewhere means a malformed request worth retrying; this
    // one means the key is wrong, so the source must be taken out of the
    // chain instead of being asked again on every request.
    expect(youtube.statusFor(400, "keyInvalid")).toBe(401);
    expect(youtube.statusFor(400, "somethingElse")).toBe(400);
    expect(youtube.statusFor(500, undefined)).toBe(500);
  });

  test("an unrecognised error keeps its own status", async () => {
    mockFetch([fail(503, { error: { message: "backend error" } })]);
    await expect(
      youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 })
    ).rejects.toMatchObject({ status: 503, message: "backend error" });
  });

  test("a response that is not JSON is still an error, not a crash", async () => {
    mockFetch([{ ok: true, status: 200, json: async () => { throw new Error("not json"); } }]);
    await expect(
      youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 })
    ).rejects.toMatchObject({ status: 200 });
  });

  test("an unreachable API is a 502, which fails over rather than looking like a bad key", async () => {
    jest.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(
      youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 })
    ).rejects.toMatchObject({ status: 502, message: "Could not reach YouTube: ENOTFOUND" });
  });

  test("an error with no message at all still says something useful", async () => {
    mockFetch([fail(418, null)]);
    await expect(
      youtube.fetchPage({ apiKey: "k", topic: "world", language: "en", skip: 0 })
    ).rejects.toMatchObject({ message: "YouTube returned HTTP 418" });
  });
});

describe("resolving one video by id", () => {
  test("a video Stremio asks for later is fetched and cached", async () => {
    mockFetch([ok({ items: [detail("dQw4w9WgXcQ")] })]);
    const a = await youtube.getArticleById("k", "dQw4w9WgXcQ");
    expect(a.id).toBe("yt_dQw4w9WgXcQ");
    expect(a.duration).toBe("9 min");
    expect(articleCache.get("yt_dQw4w9WgXcQ")).toBe(a);
  });

  test("a video that no longer exists resolves to nothing", async () => {
    mockFetch([ok({ items: [] })]);
    expect(await youtube.getArticleById("k", "gone")).toBeNull();
    mockFetch([ok({})]);
    expect(await youtube.getArticleById("k", "gone")).toBeNull();
  });
});

describe("what the provider advertises about itself", () => {
  test("it claims video, because every result is one", () => {
    expect(youtube.supportsVideo).toBe(true);
    expect(youtube.videoOnly).toBe(true);
  });

  test("every canonical topic is searchable, unlike the text APIs", () => {
    const { TOPICS } = require("../src/providers");
    TOPICS.forEach((t) => expect(typeof youtube.categories[t.id]).toBe("string"));
  });

  test("every offered language has a region to search in", () => {
    youtube.languages.forEach((code) => expect(youtube.REGIONS[code]).toMatch(/^[A-Z]{2}$/));
  });
});
