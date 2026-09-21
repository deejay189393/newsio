const { clearAllCaches, articleCache } = require("../src/cache");
const {
  fetchNews,
  getArticleById,
  normalizeArticle,
  makeArticleId,
  realText,
  isLowQuality,
  LOW_QUALITY_SOURCE_PRIORITY,
  UPSTREAM_PAGE_SIZE,
  CATALOG_PAGE_SIZE,
  MAX_PAGE_WALK
} = require("../src/newsdata");

beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

const ok = (data) => ({ ok: true, json: async () => data });
const article = (id, extra = {}) => ({
  article_id: id,
  title: `Title ${id}`,
  link: `https://example.com/${id}`,
  ...extra
});

describe("makeArticleId / stable ids", () => {
  test("uses newsdata's article_id behind the nd_ prefix", () => {
    expect(makeArticleId({ article_id: "abc123" })).toBe("nd_abc123");
  });

  test("is deterministic for the same story when article_id is missing", () => {
    const raw = { link: "https://example.com/story", title: "T" };
    expect(makeArticleId(raw)).toBe(makeArticleId({ ...raw }));
  });

  test("different stories get different ids in the fallback path", () => {
    expect(makeArticleId({ link: "https://a.com/1" })).not.toBe(makeArticleId({ link: "https://a.com/2" }));
  });

  test("fallback id is URL-safe (base64url: no +, / or =)", () => {
    const id = makeArticleId({ link: "https://example.com/a?b=c&d=e/f+g~h" });
    expect(id.slice(3)).not.toMatch(/[+/=]/);
  });

  test("does not throw on a story with neither id, link nor title", () => {
    expect(() => makeArticleId({})).not.toThrow();
    expect(makeArticleId({})).toBe("nd_");
  });
});

describe("normalizeArticle", () => {
  test("maps every upstream field we rely on", () => {
    const n = normalizeArticle({
      article_id: "a1",
      title: "T",
      description: "D",
      link: "https://e.com/a1",
      image_url: "https://e.com/i.jpg",
      video_url: "https://e.com/v.mp4",
      pubDate: "2026-09-18 10:00:00",
      source_name: "Src",
      source_icon: "https://e.com/ico.png",
      category: ["technology"],
      keywords: ["chips", "ai"],
      creator: ["Jane", "John"]
    });
    expect(n).toEqual({
      id: "nd_a1",
      title: "T",
      description: "D",
      link: "https://e.com/a1",
      image: "https://e.com/i.jpg",
      videoUrl: "https://e.com/v.mp4",
      pubDate: "2026-09-18 10:00:00",
      sourceName: "Src",
      sourceId: null,
      sourcePriority: null,
      sourceIcon: "https://e.com/ico.png",
      category: "technology",
      categories: ["technology"],
      keywords: ["chips", "ai"],
      creator: "Jane, John"
    });
  });

  test("keywords default to an empty list and drop non-strings", () => {
    expect(normalizeArticle({ article_id: "x" }).keywords).toEqual([]);
    expect(normalizeArticle({ article_id: "x", keywords: "nope" }).keywords).toEqual([]);
    expect(normalizeArticle({ article_id: "x", keywords: ["ok", 5, null] }).keywords).toEqual(["ok"]);
  });

  test("falls back to content when description is absent", () => {
    expect(normalizeArticle({ article_id: "x", content: "body text" }).description).toBe("body text");
  });

  // On the free tier newsdata.io fills content/ai_summary with an upsell
  // string. It used to be served to users as the article description of any
  // story whose own description was empty.
  describe("free-tier upsell placeholders", () => {
    test.each([
      "ONLY AVAILABLE IN PAID PLANS",
      "ONLY AVAILABLE IN PROFESSIONAL AND CORPORATE PLANS",
      "ONLY AVAILABLE IN CORPORATE PLANS",
      "only available in paid plans",
      "  ONLY AVAILABLE IN PAID PLANS  "
    ])("%s is treated as no text at all", (placeholder) => {
      expect(realText(placeholder)).toBe("");
      expect(normalizeArticle({ article_id: "x", content: placeholder }).description).toBe("");
      expect(normalizeArticle({ article_id: "x", description: placeholder, content: "real" }).description).toBe(
        "real"
      );
    });

    test("a description that merely mentions a plan is kept", () => {
      const real = "The company said only available seats in paid plans would remain.";
      expect(realText(real)).toBe(real);
    });

    test("realText trims and rejects non-strings", () => {
      expect(realText("  hi  ")).toBe("hi");
      expect(realText("")).toBe("");
      expect(realText(null)).toBe("");
      expect(realText(42)).toBe("");
    });

    test("an empty description no longer yields placeholder text", () => {
      const n = normalizeArticle({ article_id: "x", description: "", content: "ONLY AVAILABLE IN PAID PLANS" });
      expect(n.description).toBe("");
      expect(n.description).not.toMatch(/ONLY AVAILABLE/i);
    });
  });

  test("falls back to source_id when source_name is absent", () => {
    expect(normalizeArticle({ article_id: "x", source_id: "bbc" }).sourceName).toBe("bbc");
  });

  test("uses a placeholder source when the story names none", () => {
    expect(normalizeArticle({ article_id: "x" }).sourceName).toBe("Unknown source");
  });

  test("handles scalar (non-array) category and creator", () => {
    const n = normalizeArticle({ article_id: "x", category: "tech", creator: "Solo" });
    expect(n.category).toBe("tech");
    expect(n.creator).toBe("Solo");
  });

  test("nulls out absent optional fields rather than leaving them undefined", () => {
    const n = normalizeArticle({ article_id: "x" });
    expect(n.image).toBeNull();
    expect(n.videoUrl).toBeNull();
    expect(n.pubDate).toBeNull();
    expect(n.category).toBeNull();
    expect(n.creator).toBeNull();
    expect(n.title).toBe("Untitled");
    expect(n.keywords).toEqual([]);
    expect(n.categories).toEqual([]);
    expect(n.sourceId).toBeNull();
  });

  test("keeps the whole category list, not just the first entry", () => {
    // The first is almost always "top", which is a feed designation.
    expect(normalizeArticle({ article_id: "x", category: ["top", "technology"] }).categories).toEqual([
      "top",
      "technology"
    ]);
    expect(normalizeArticle({ article_id: "x", category: ["top", "technology"] }).category).toBe("top");
  });

  test("carries source_id so a publisher's own tag can be recognised", () => {
    expect(normalizeArticle({ article_id: "x", source_id: "dailymail" }).sourceId).toBe("dailymail");
  });

  test("carries source_priority, and only when it is a number", () => {
    expect(normalizeArticle({ article_id: "x", source_priority: 165 }).sourcePriority).toBe(165);
    expect(normalizeArticle({ article_id: "x", source_priority: "165" }).sourcePriority).toBeNull();
    expect(normalizeArticle({ article_id: "x" }).sourcePriority).toBeNull();
  });

  test("a non-array category field yields an empty categories list", () => {
    expect(normalizeArticle({ article_id: "x", category: "tech" }).categories).toEqual([]);
    expect(normalizeArticle({ article_id: "x", category: ["a", 5, "b"] }).categories).toEqual(["a", "b"]);
  });

  test("descriptions are never truncated by us", () => {
    const long = "x".repeat(1200);
    expect(normalizeArticle({ article_id: "x", description: long }).description).toHaveLength(1200);
  });
});

/**
 * A page of `n` upstream articles, numbered from `start`, with an optional
 * cursor for the page after it. Mirrors newsdata.io: at most 10 results per
 * response, paging by an opaque `nextPage` token rather than an offset.
 */
const upstreamPage = (start, n = UPSTREAM_PAGE_SIZE, nextPage = null) =>
  ok({ results: Array.from({ length: n }, (_, k) => article(`a${start + k}`)), nextPage });

/** A chain of sequential upstream pages, each pointing at the next. */
function mockChain(pageCount, perPage = UPSTREAM_PAGE_SIZE) {
  const fn = jest.fn();
  for (let i = 0; i < pageCount; i++) {
    const last = i === pageCount - 1;
    fn.mockResolvedValueOnce(upstreamPage(i * perPage, perPage, last ? null : `T${i + 1}`));
  }
  return (global.fetch = fn);
}

const ids = (res) => res.articles.map((a) => a.id);
const BASE = { apiKey: "K", category: "technology", language: "en" };

describe("page size", () => {
  test("a catalog page is 20 articles, built from two upstream pages of 10", async () => {
    const fetchMock = mockChain(2);
    const res = await fetchNews({ ...BASE });
    expect(res.articles).toHaveLength(CATALOG_PAGE_SIZE);
    expect(CATALOG_PAGE_SIZE).toBe(20);
    expect(UPSTREAM_PAGE_SIZE).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("asks newsdata.io to collapse syndicated duplicates", async () => {
    mockChain(2);
    await fetchNews({ ...BASE });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("removeduplicate")).toBe("1");
  });

  test("returns fewer than a full page when upstream runs out", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(upstreamPage(0, 7, null));
    const res = await fetchNews({ ...BASE });
    expect(res.articles).toHaveLength(7);
    expect(res.hasMore).toBe(false);
  });

  test("never repeats a story within one page", async () => {
    // The same story served by two consecutive upstream pages (the feed
    // shifted between calls) must not appear twice in one response.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(ok({ results: [article("dup"), article("x1")], nextPage: "T1" }))
      .mockResolvedValueOnce(ok({ results: [article("dup"), article("x2")], nextPage: null }));
    const res = await fetchNews({ ...BASE });
    expect(ids(res)).toEqual(["nd_dup", "nd_x1", "nd_x2"]);
  });
});

describe("fetchNews — skip is an absolute item offset", () => {
  test("skip=0 returns the first 20 stories", async () => {
    mockChain(2);
    expect(ids(await fetchNews({ ...BASE, skip: 0 }))).toEqual(
      Array.from({ length: 20 }, (_, i) => `nd_a${i}`)
    );
  });

  test("skip=20 returns the next 20, with no overlap", async () => {
    mockChain(4);
    const first = await fetchNews({ ...BASE, skip: 0 });
    const second = await fetchNews({ ...BASE, skip: 20 });
    expect(ids(second)).toEqual(Array.from({ length: 20 }, (_, i) => `nd_a${20 + i}`));
    expect(ids(first).filter((id) => ids(second).includes(id))).toEqual([]);
  });

  test("three sequential pages yield 60 distinct stories", async () => {
    mockChain(6);
    const all = [];
    for (const skip of [0, 20, 40]) all.push(...ids(await fetchNews({ ...BASE, skip })));
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
  });

  test("sequential scrolling costs only two upstream calls per page", async () => {
    const fetchMock = mockChain(6);
    await fetchNews({ ...BASE, skip: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await fetchNews({ ...BASE, skip: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await fetchNews({ ...BASE, skip: 40 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test("re-requesting a page costs nothing", async () => {
    const fetchMock = mockChain(2);
    const first = await fetchNews({ ...BASE, skip: 0 });
    const again = await fetchNews({ ...BASE, skip: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ids(again)).toEqual(ids(first));
  });

  // Regression: skip used to be divided by the page size and floored, so a
  // skip that did not land on a boundary silently re-served an earlier page.
  test("a skip that is not a multiple of the page size is honoured exactly", async () => {
    mockChain(4);
    const res = await fetchNews({ ...BASE, skip: 5 });
    expect(ids(res)).toEqual(Array.from({ length: 20 }, (_, i) => `nd_a${5 + i}`));
  });

  test("a skip mid-way through an upstream page is honoured exactly", async () => {
    mockChain(4);
    const res = await fetchNews({ ...BASE, skip: 13 });
    expect(ids(res)[0]).toBe("nd_a13");
    expect(res.articles).toHaveLength(20);
  });

  test("a cold deep skip walks the cursor chain to get there", async () => {
    const fetchMock = mockChain(8);
    const res = await fetchNews({ ...BASE, skip: 60 });
    expect(ids(res)[0]).toBe("nd_a60");
    // pages 0..7 walked; only 6 and 7 are returned
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  test("resumes from the furthest cached cursor instead of page 0", async () => {
    const fetchMock = mockChain(8);
    await fetchNews({ ...BASE, skip: 0 });   // caches pages 0,1
    await fetchNews({ ...BASE, skip: 20 });  // caches pages 2,3
    fetchMock.mockClear();
    await fetchNews({ ...BASE, skip: 40 });  // should fetch only 4,5
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["a negative skip", -50],
    ["a non-numeric skip", "abc"],
    ["an undefined skip", undefined],
    ["a null skip", null]
  ])("%s is treated as the first page", async (_label, skip) => {
    mockChain(2);
    const res = await fetchNews({ ...BASE, skip });
    expect(ids(res)[0]).toBe("nd_a0");
  });

  test("a fractional skip is floored", async () => {
    mockChain(4);
    expect(ids(await fetchNews({ ...BASE, skip: 20.9 }))[0]).toBe("nd_a20");
  });
});

describe("fetchNews — end of feed", () => {
  test("stops when upstream runs out mid-page", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(upstreamPage(0, 10, "T1"))
      .mockResolvedValueOnce(upstreamPage(10, 4, null));
    const res = await fetchNews({ ...BASE });
    expect(res.articles).toHaveLength(14);
    expect(res.hasMore).toBe(false);
  });

  // Regression: a cached null cursor used to be skipped over as "not
  // fetched yet", so paging past the end refetched page 0 and served it
  // again -- the same headlines on every further scroll.
  test("does not replay page 0 once a page is known to be the last", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(upstreamPage(0, 6, null));
    const first = await fetchNews({ ...BASE, skip: 0 });
    expect(first.articles).toHaveLength(6);

    global.fetch.mockClear();
    const past = await fetchNews({ ...BASE, skip: 20 });
    expect(past.articles).toEqual([]);
    expect(past.hasMore).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("every page beyond a known-last page is empty, not just the next one", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(upstreamPage(0, 5, null));
    await fetchNews({ ...BASE, skip: 0 });
    global.fetch.mockClear();
    for (const skip of [20, 40, 100]) {
      expect((await fetchNews({ ...BASE, skip })).articles).toEqual([]);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("a deep, never-seen skip is capped rather than walked forever", async () => {
    const fetchMock = jest.fn().mockResolvedValue(upstreamPage(0, 10, "T"));
    global.fetch = fetchMock;
    const res = await fetchNews({ ...BASE, skip: MAX_PAGE_WALK * UPSTREAM_PAGE_SIZE + 500 });
    expect(res.articles).toEqual([]);
    expect(res.truncated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the cap allows the pages the manifest actually advertises", async () => {
    // Worst case a client can reach by stepping through the declared skip
    // options with a cold cache one step at a time.
    expect(MAX_PAGE_WALK).toBeGreaterThanOrEqual(CATALOG_PAGE_SIZE / UPSTREAM_PAGE_SIZE);
  });
});

describe("fetchNews — query shape", () => {
  test("sends the category for a topic browse", async () => {
    mockChain(2);
    await fetchNews({ ...BASE });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get("category")).toBe("technology");
    expect(url.searchParams.has("q")).toBe(false);
  });

  test("sends q and no category for a search", async () => {
    mockChain(2);
    await fetchNews({ apiKey: "K", query: "ai chips", language: "en" });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("ai chips");
    expect(url.searchParams.has("category")).toBe(false);
  });

  test("defaults the language to English", async () => {
    mockChain(2);
    await fetchNews({ apiKey: "K", category: "top" });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("language")).toBe("en");
  });

  test("searches and topics cache separately", async () => {
    const fetchMock = mockChain(4);
    await fetchNews({ ...BASE });
    await fetchNews({ apiKey: "K", query: "ai", language: "en" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("the cursor sent for page 2 is the token page 1 returned", async () => {
    mockChain(4);
    await fetchNews({ ...BASE, skip: 0 });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.has("page")).toBe(false);
    expect(new URL(global.fetch.mock.calls[1][0]).searchParams.get("page")).toBe("T1");
  });

  test("requires an API key", async () => {
    await expect(fetchNews({ category: "top" })).rejects.toMatchObject({ status: 401 });
  });
});

describe("quality filtering — what the API will not flag", () => {
  // newsdata.io has no sponsored/advertisement marker: datatype covers
  // news/blog/review/multimedia/podcast/analysis and nothing else, and a
  // plain affiliate post arrives as datatype "news". These are the two
  // deterministic signals that do exist.
  const art = (over) => normalizeArticle({ article_id: "x", title: "T", description: "D", ...over });

  describe("SEO content farms, by source_priority", () => {
    test.each([
      ["a content farm", 99999999, true],
      ["a stock-spam aggregator", 5143682, true],
      ["just over the line", LOW_QUALITY_SOURCE_PRIORITY + 1, true],
      ["exactly on the line", LOW_QUALITY_SOURCE_PRIORITY, false],
      ["a minor real publisher", 1200410, false],
      ["CNN", 165, false],
      ["Google News", 14, false]
    ])("%s (priority %p) -> dropped=%p", (_label, source_priority, expected) => {
      expect(isLowQuality(art({ source_priority }))).toBe(expected);
    });

    test("a story with no title or description is judged on its source alone", () => {
      expect(isLowQuality({})).toBe(false);
      expect(isLowQuality({ sourcePriority: 99999999 })).toBe(true);
      expect(isLowQuality({ title: null, description: null })).toBe(false);
    });

    test("a missing source_priority is never grounds to drop a story", () => {
      expect(isLowQuality(art({}))).toBe(false);
      expect(isLowQuality(art({ source_priority: "not a number" }))).toBe(false);
    });
  });

  describe("retail posts dressed as stories", () => {
    test.each([
      "Power outages happen—save up to 57% on EcoFlow power stations",
      "The best deals on laptops this weekend",
      "Deal of the day: noise-cancelling headphones",
      "Grab this coupon code before midnight",
      "Shop now and save",
      "Top deals for the long weekend",
      "Prime Day deals you can still get",
      "Black Friday deals are live"
    ])("drops %p", (title) => {
      expect(isLowQuality(art({ title }))).toBe(true);
    });

    test("catches an ad embedded in the description, not just the headline", () => {
      const embedded = art({
        title: "How to watch Cleveland Browns vs. Tampa Bay Buccaneers",
        description: "Start streaming DIRECTV & save up to $30 off your 1st mo. of service!"
      });
      expect(isLowQuality(embedded)).toBe(true);
    });

    // Kept narrow on purpose: a discount in a headline is often the news.
    test.each([
      "Government cuts rail fares by 50% from Monday",
      "Retailer reports a 30% fall in quarterly profit",
      "Shoppers spent less this Black Friday, data shows",
      "Inflation eases as food prices drop",
      "A review of the new flagship phone"
    ])("keeps genuine reporting: %p", (title) => {
      expect(isLowQuality(art({ title }))).toBe(false);
    });
  });

  test("filtered stories do not reach a catalog page", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      ok({
        results: [
          { article_id: "good1", title: "Real news", link: "https://e/1", source_priority: 100 },
          { article_id: "farm", title: "Farm piece", link: "https://e/2", source_priority: 99999999 },
          { article_id: "ad", title: "Save up to 40% on blenders", link: "https://e/3", source_priority: 100 },
          { article_id: "good2", title: "More real news", link: "https://e/4", source_priority: 100 }
        ],
        nextPage: null
      })
    );
    const res = await fetchNews({ apiKey: "K", category: "top" });
    expect(res.articles.map((a) => a.id)).toEqual(["nd_good1", "nd_good2"]);
  });

  // Filtering after the slice keeps each catalog page mapped to a fixed span
  // of upstream results; filtering before it would make pages drift and
  // start overlapping.
  test("filtering never makes two pages overlap", async () => {
    const page = (start, next) =>
      ok({
        results: Array.from({ length: 10 }, (_, k) => ({
          article_id: `a${start + k}`,
          title: k % 3 === 0 ? "Best deals of the week" : `Story ${start + k}`,
          link: `https://e/${start + k}`,
          source_priority: 100
        })),
        nextPage: next
      });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(page(0, "T1"))
      .mockResolvedValueOnce(page(10, "T2"))
      .mockResolvedValueOnce(page(20, "T3"))
      .mockResolvedValueOnce(page(30, null));

    const p1 = await fetchNews({ apiKey: "K", category: "top", skip: 0 });
    const p2 = await fetchNews({ apiKey: "K", category: "top", skip: 20 });
    const first = new Set(p1.articles.map((a) => a.id));
    expect(p2.articles.filter((a) => first.has(a.id))).toEqual([]);
    expect(p1.articles.length).toBeLessThan(CATALOG_PAGE_SIZE); // some were dropped
    expect(p1.articles.every((a) => !/best deals/i.test(a.title))).toBe(true);
  });
});

describe("upstream failures", () => {
  const BASE2 = { apiKey: "K", category: "top" };

  test("a network failure becomes a 502", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(fetchNews(BASE2)).rejects.toMatchObject({ status: 502 });
    await expect(fetchNews(BASE2)).rejects.toThrow(/Could not reach newsdata.io/);
  });

  test("surfaces newsdata.io's own message from results.message", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ results: { message: "Rate limit exceeded" } })
    });
    await expect(fetchNews(BASE2)).rejects.toThrow("Rate limit exceeded");
  });

  test("surfaces a top-level message when there is no results envelope", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: "Invalid API key" })
    });
    await expect(fetchNews(BASE2)).rejects.toMatchObject({ status: 401 });
    await expect(fetchNews(BASE2)).rejects.toThrow("Invalid API key");
  });

  test("falls back to a generic message when the error body is not JSON", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      }
    });
    await expect(fetchNews(BASE2)).rejects.toThrow("newsdata.io returned HTTP 500");
  });

  test("falls back to a generic message when the body is JSON but empty", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(fetchNews(BASE2)).rejects.toThrow("newsdata.io returned HTTP 503");
  });

  test("a malformed results field yields an empty page rather than throwing", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: "nonsense", nextPage: null }));
    const res = await fetchNews(BASE2);
    expect(res.articles).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  test("a missing results field yields an empty page", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ nextPage: null }));
    expect((await fetchNews(BASE2)).articles).toEqual([]);
  });
});

describe("getArticleById", () => {
  test("returns a cached article without touching the network", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    await fetchNews({ apiKey: "k", category: "top" });
    global.fetch.mockClear();

    const found = await getArticleById("k", "nd_a1");
    expect(found.id).toBe("nd_a1");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("falls back to a direct id lookup when not cached", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("never_seen", { title: "Refetched" })] }));
    const found = await getArticleById("k", "nd_never_seen");
    expect(found.title).toBe("Refetched");
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get("id")).toBe("never_seen"); // prefix stripped
    expect(url.searchParams.get("apikey")).toBe("k");
  });

  test("caches the result of a fallback lookup", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("x1")] }));
    await getArticleById("k", "nd_x1");
    global.fetch.mockClear();
    await getArticleById("k", "nd_x1");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("returns null without an apiKey", async () => {
    expect(await getArticleById("", "nd_x")).toBeNull();
    expect(await getArticleById(undefined, "nd_x")).toBeNull();
  });

  test("returns null for an id without our nd_ prefix", async () => {
    global.fetch = jest.fn();
    expect(await getArticleById("k", "tt1234567")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled(); // never queries upstream for a foreign id
  });

  test("returns null for a non-string id", async () => {
    expect(await getArticleById("k", undefined)).toBeNull();
    expect(await getArticleById("k", 42)).toBeNull();
  });

  test("returns null when upstream finds nothing", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [] }));
    expect(await getArticleById("k", "nd_missing")).toBeNull();
  });

  test("returns null when upstream returns a malformed payload", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({}));
    expect(await getArticleById("k", "nd_missing")).toBeNull();
  });

  test("returns null rather than throwing when the lookup errors", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    expect(await getArticleById("k", "nd_x")).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});
