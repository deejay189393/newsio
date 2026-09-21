const { clearAllCaches, articleCache } = require("../src/cache");
const registry = require("../src/providers");
const newsdata = require("../src/providers/newsdata");
const currents = require("../src/providers/currents");
const gnews = require("../src/providers/gnews");

beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

const ok = (data) => ({ ok: true, json: async () => data });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

describe("the registry", () => {
  test("offers the providers freshest-first", () => {
    expect(registry.PROVIDERS.map((p) => p.id)).toEqual(["currents", "newsdata", "gnews"]);
  });

  test("every provider satisfies the same interface", () => {
    registry.PROVIDERS.forEach((p) => {
      expect(typeof p.id).toBe("string");
      expect(typeof p.label).toBe("string");
      expect(typeof p.notes).toBe("string");
      expect(typeof p.signupUrl).toBe("string");
      expect(typeof p.fetchPage).toBe("function");
      expect(typeof p.getArticleById).toBe("function");
      expect(typeof p.normalize).toBe("function");
      expect(p.idPrefix).toMatch(/^[a-z]{2}_$/);
    });
  });

  test("id prefixes are unique, so an article id names exactly one provider", () => {
    const prefixes = registry.PROVIDERS.map((p) => p.idPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  test.each([
    ["cu_abc", "currents"],
    ["nd_abc", "newsdata"],
    ["gn_abc", "gnews"]
  ])("%p routes back to %p", (id, provider) => {
    expect(registry.providerForArticleId(id).id).toBe(provider);
  });

  test.each([["zz_abc"], [""], [null], [undefined], [42]])("%p routes nowhere", (id) => {
    expect(registry.providerForArticleId(id)).toBeUndefined();
  });

  test("every provider maps every canonical topic, even if only to null", () => {
    registry.PROVIDERS.forEach((p) => {
      registry.TOPICS.forEach((t) => {
        expect(Object.prototype.hasOwnProperty.call(p.categories, t.id)).toBe(true);
      });
    });
  });

  test("a topic mapped to null means that provider is skipped for it", () => {
    expect(registry.providerSupportsTopic(gnews, "crime")).toBe(false);
    expect(registry.providerSupportsTopic(currents, "crime")).toBe(false);
    expect(registry.providerSupportsTopic(newsdata, "crime")).toBe(true);
  });

  test("at least one provider can serve every topic offered", () => {
    registry.TOPICS.forEach((t) => {
      expect(registry.PROVIDERS.some((p) => registry.providerSupportsTopic(p, t.id))).toBe(true);
    });
  });

  test("topic labels and validity", () => {
    expect(registry.getTopicLabel("business")).toBe("Finance & Business");
    expect(registry.getTopicLabel("nope")).toBeNull();
    expect(registry.isValidTopicId("technology")).toBe(true);
    expect(registry.isValidTopicId("nope")).toBe(false);
    expect(registry.getTopicById("top").label).toBe("Top Stories");
  });

  test("provider lookup and validity", () => {
    expect(registry.getProvider("currents")).toBe(currents);
    expect(registry.getProvider("nope")).toBeUndefined();
    expect(registry.isValidProviderId("gnews")).toBe(true);
    expect(registry.isValidProviderId("nope")).toBe(false);
    expect(registry.providerSupportsTopic(undefined, "top")).toBe(false);
  });

  test("every provider declares the languages the page offers", () => {
    registry.LANGUAGES.forEach((l) => {
      registry.PROVIDERS.forEach((p) => expect(p.languages).toContain(l.code));
    });
  });
});

describe("newsdata provider", () => {
  const page = (start, n, next) =>
    ok({
      results: Array.from({ length: n }, (_, k) => ({
        article_id: `a${start + k}`,
        title: `Story ${start + k}`,
        link: `https://e/${start + k}`
      })),
      nextPage: next
    });

  test("assembles a 20-item page from two 10-item responses", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(page(0, 10, "T1")).mockResolvedValueOnce(page(10, 10, "T2"));
    const res = await newsdata.fetchPage({ apiKey: "K", topic: "technology", language: "en", skip: 0 });
    expect(res.articles).toHaveLength(20);
    expect(res.articles[0].id).toBe("nd_a0");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("sends the mapped category and asks for duplicates to be collapsed", async () => {
    global.fetch = jest.fn().mockResolvedValue(page(0, 10, null));
    await newsdata.fetchPage({ apiKey: "K", topic: "technology", language: "en", skip: 0 });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get("category")).toBe("technology");
    expect(url.searchParams.get("removeduplicate")).toBe("1");
    expect(url.searchParams.get("language")).toBe("en");
  });

  test("a search drops the category and sends q", async () => {
    global.fetch = jest.fn().mockResolvedValue(page(0, 10, null));
    await newsdata.fetchPage({ apiKey: "K", query: "ai chips", language: "en", skip: 0 });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("ai chips");
    expect(url.searchParams.has("category")).toBe(false);
  });

  test("walks the cursor chain, sending page 1's token for page 2", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(page(0, 10, "T1")).mockResolvedValueOnce(page(10, 10, null));
    await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.has("page")).toBe(false);
    expect(new URL(global.fetch.mock.calls[1][0]).searchParams.get("page")).toBe("T1");
  });

  test("sequential scrolling costs two calls per page and re-visits cost none", async () => {
    const f = jest.fn();
    for (let i = 0; i < 6; i++) f.mockResolvedValueOnce(page(i * 10, 10, i === 5 ? null : `T${i + 1}`));
    global.fetch = f;
    await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 });
    expect(f).toHaveBeenCalledTimes(2);
    await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 20 });
    expect(f).toHaveBeenCalledTimes(4);
    await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 });
    expect(f).toHaveBeenCalledTimes(4);
  });

  // Regression: a cached null cursor used to be skipped over as "not fetched
  // yet", so paging past the end refetched page 0 and served it again.
  test("does not replay page 0 once a page is known to be the last", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(page(0, 6, null));
    const first = await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 });
    expect(first.articles).toHaveLength(6);
    global.fetch.mockClear();
    const past = await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 20 });
    expect(past.articles).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // The walk can hit the end of the feed before reaching the page asked for.
  test("a walk that runs out of pages before its target returns empty", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(page(0, 10, "T1"))
      .mockResolvedValueOnce(page(10, 10, null)); // feed ends at page 1
    const res = await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 60 });
    expect(res.articles).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  test("a deep, never-seen skip is capped rather than walked forever", async () => {
    global.fetch = jest.fn().mockResolvedValue(page(0, 10, "T"));
    const res = await newsdata.fetchPage({
      apiKey: "K",
      topic: "top",
      language: "en",
      skip: (newsdata.MAX_PAGE_WALK + 5) * newsdata.UPSTREAM_PAGE_SIZE
    });
    expect(res.truncated).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // A page already in the cache mid-walk must be reused for its cursor
  // rather than refetched, and must end the walk if it was the last.
  test("reuses a cached intermediate page while walking to a later one", async () => {
    const f = jest.fn();
    for (let i = 0; i < 4; i++) f.mockResolvedValueOnce(page(i * 10, 10, `T${i + 1}`));
    global.fetch = f;
    await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 }); // caches 0,1
    f.mockClear();
    f.mockResolvedValueOnce(page(20, 10, "T3")).mockResolvedValueOnce(page(30, 10, null));
    const res = await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 20 });
    expect(res.articles[0].id).toBe("nd_a20");
    expect(f).toHaveBeenCalledTimes(2); // only pages 2 and 3
  });

  test("a cached page that was upstream's last ends a deeper walk", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(page(0, 10, "T1")).mockResolvedValueOnce(page(10, 10, null));
    await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 });
    global.fetch.mockClear();
    const res = await newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 40 });
    expect(res.articles).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("resolves a single article by id, which /meta relies on", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [{ article_id: "x", title: "T", link: "https://e/x" }] }));
    const article = await newsdata.getArticleById("K", "x");
    expect(article.id).toBe("nd_x");
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("id")).toBe("x");
    expect(articleCache.get("nd_x")).toBeTruthy();
  });

  test.each([
    ["an empty results list", { results: [] }],
    ["a malformed results field", { results: "nonsense" }],
    ["no results field at all", {}]
  ])("an id answered with %s resolves to null rather than throwing", async (_l, body) => {
    global.fetch = jest.fn().mockResolvedValue(ok(body));
    expect(await newsdata.getArticleById("K", "nope")).toBeNull();
  });

  test("requires an API key", async () => {
    await expect(newsdata.fetchPage({ topic: "top", language: "en", skip: 0 })).rejects.toMatchObject({ status: 401 });
  });

  describe("upstream failures", () => {
    const attempt = () => newsdata.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 });

    test("a network failure becomes a 502", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
      await expect(attempt()).rejects.toMatchObject({ status: 502 });
    });

    test("surfaces the message from results.message", async () => {
      global.fetch = jest.fn().mockResolvedValue(fail(429, { results: { message: "Rate limit exceeded" } }));
      await expect(attempt()).rejects.toThrow("Rate limit exceeded");
    });

    test("surfaces a top-level message", async () => {
      global.fetch = jest.fn().mockResolvedValue(fail(401, { message: "Invalid API key" }));
      await expect(attempt()).rejects.toThrow("Invalid API key");
    });

    test("falls back to a generic message when the body is not JSON", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        }
      });
      await expect(attempt()).rejects.toThrow("newsdata.io returned HTTP 500");
    });

    test.each([
      ["an empty results envelope", { results: {} }],
      ["an empty body", {}],
      ["a null body", null]
    ])("falls back to a generic message for %s", async (_l, body) => {
      global.fetch = jest.fn().mockResolvedValue(fail(503, body));
      await expect(attempt()).rejects.toThrow("newsdata.io returned HTTP 503");
    });

    test("a malformed results field yields an empty page rather than throwing", async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({ results: "nonsense", nextPage: null }));
      expect((await attempt()).articles).toEqual([]);
    });
  });

  describe("normalize", () => {
    test("maps every field the addon relies on", () => {
      const n = newsdata.normalize({
        article_id: "a1",
        title: "AT&amp;T",
        description: "D",
        link: "https://e/1",
        image_url: "https://e/i.jpg",
        video_url: "https://e/v.mp4",
        pubDate: "2026-09-18 10:00:00",
        source_name: "Src",
        source_id: "src",
        source_priority: 165,
        source_icon: "https://e/ico.png",
        category: ["top", "technology"],
        keywords: ["chips", "telco &amp; isp"],
        creator: ["Jane", "John"]
      });
      expect(n).toEqual({
        id: "nd_a1",
        title: "AT&T",
        description: "D",
        link: "https://e/1",
        image: "https://e/i.jpg",
        videoUrl: "https://e/v.mp4",
        pubDate: "2026-09-18 10:00:00",
        sourceName: "Src",
        sourceId: "src",
        sourcePriority: 165,
        sourceIcon: "https://e/ico.png",
        categories: ["top", "technology"],
        keywords: ["chips", "telco & isp"],
        creator: "Jane, John",
        provider: "newsdata"
      });
    });

    test("the paid-plan placeholder never becomes the description", () => {
      const n = newsdata.normalize({ article_id: "x", description: "", content: "ONLY AVAILABLE IN PAID PLANS" });
      expect(n.description).toBe("");
    });

    test("falls back sensibly when fields are missing", () => {
      const n = newsdata.normalize({ article_id: "x" });
      expect(n.title).toBe("Untitled");
      expect(n.sourceName).toBe("Unknown source");
      expect(n.categories).toEqual([]);
      expect(n.keywords).toEqual([]);
      expect(n.videoUrl).toBeNull();
      expect(n.sourcePriority).toBeNull();
    });

    test("handles a scalar creator and a non-numeric priority", () => {
      expect(newsdata.normalize({ article_id: "x", creator: "Solo" }).creator).toBe("Solo");
      expect(newsdata.normalize({ article_id: "x", source_priority: "165" }).sourcePriority).toBeNull();
    });
  });
});

describe("currents provider", () => {
  const news = (start, n) =>
    ok({
      status: "ok",
      news: Array.from({ length: n }, (_, k) => ({
        id: `c${start + k}`,
        title: `Story ${start + k}`,
        url: `https://www.example.com/${start + k}`,
        description: "D",
        published: "2026-09-21 02:00:00 +0000",
        category: ["technology"]
      }))
    });

  test("one request fills a whole catalog page", async () => {
    global.fetch = jest.fn().mockResolvedValue(news(0, 20));
    const res = await currents.fetchPage({ apiKey: "K", topic: "technology", language: "en", skip: 0 });
    expect(res.articles).toHaveLength(20);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(res.articles[0].id).toBe("cu_c0");
  });

  test("pages by a 1-based page_number rather than a cursor", async () => {
    global.fetch = jest.fn().mockResolvedValue(news(0, 20));
    await currents.fetchPage({ apiKey: "K", topic: "technology", language: "en", skip: 0 });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("page_number")).toBe("1");
    global.fetch.mockClear();
    await currents.fetchPage({ apiKey: "K", topic: "technology", language: "en", skip: 20 });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("page_number")).toBe("2");
  });

  test("maps canonical topics to its own vocabulary", async () => {
    global.fetch = jest.fn().mockResolvedValue(news(0, 20));
    await currents.fetchPage({ apiKey: "K", topic: "tourism", language: "en", skip: 0 });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("category")).toBe("travel");
  });

  test("refuses a topic it has no category for, so the chain moves on", async () => {
    global.fetch = jest.fn();
    await expect(currents.fetchPage({ apiKey: "K", topic: "crime", language: "en", skip: 0 })).rejects.toMatchObject({
      status: 404
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("a search sends keywords and no category", async () => {
    global.fetch = jest.fn().mockResolvedValue(news(0, 20));
    await currents.fetchPage({ apiKey: "K", query: "ai", language: "en", skip: 0 });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get("keywords")).toBe("ai");
    expect(url.searchParams.has("category")).toBe(false);
  });

  // Currents answers 200 with {"status":"error"} as readily as it uses a code.
  test("treats a 200 carrying status:error as a failure", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ status: "error", message: "quota" }));
    await expect(currents.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).rejects.toMatchObject({
      status: 429
    });
  });

  test("a network failure becomes a 502", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(currents.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).rejects.toMatchObject({
      status: 502
    });
  });

  test("requires an API key", async () => {
    await expect(currents.fetchPage({ topic: "top", language: "en", skip: 0 })).rejects.toMatchObject({ status: 401 });
  });

  test("serves a repeat request from cache without asking again", async () => {
    global.fetch = jest.fn().mockResolvedValue(news(0, 20));
    await currents.fetchPage({ apiKey: "K", topic: "technology", language: "en", skip: 0 });
    global.fetch.mockClear();
    const again = await currents.fetchPage({ apiKey: "K", topic: "technology", language: "en", skip: 0 });
    expect(again.articles).toHaveLength(20);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["message", { status: "error", message: "m" }, "m"],
    ["msg", { status: "error", msg: "s" }, "s"],
    ["error", { status: "error", error: "e" }, "e"]
  ])("surfaces its %p field", async (_l, body, expected) => {
    global.fetch = jest.fn().mockResolvedValue(ok(body));
    await expect(currents.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).rejects.toThrow(expected);
  });

  test("falls back to a generic message when the body is not JSON", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      }
    });
    await expect(currents.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).rejects.toThrow(
      "Currents returned HTTP 503"
    );
  });

  test("omits parameters it has no value for", async () => {
    global.fetch = jest.fn().mockResolvedValue(news(0, 20));
    await currents.fetchPage({ apiKey: "K", topic: "technology", language: undefined, skip: 0 });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.has("language")).toBe(false);
  });

  test("a malformed news field yields an empty page", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ status: "ok", news: "nonsense" }));
    expect((await currents.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).articles).toEqual([]);
  });

  test("a host with no usable name falls back rather than showing an empty publisher", () => {
    expect(currents.normalize({ id: "x", url: "https://.com/a" }).sourceName).toBe("Unknown source");
  });

  test("has no single-article endpoint, and says so by returning null", async () => {
    expect(await currents.getArticleById("K", "c1")).toBeNull();
  });

  describe("normalize", () => {
    test("derives a publisher from the article host, since Currents names none", () => {
      expect(currents.normalize({ id: "x", url: "https://www.winnipegfreepress.com/a" }).sourceName).toBe(
        "Winnipegfreepress"
      );
      expect(currents.normalize({ id: "x", url: "not a url" }).sourceName).toBe("Unknown source");
    });

    // Its author field concatenates every byline the scraper saw, feed
    // plumbing included.
    test("keeps only the first byline and drops the scraper's own name", () => {
      expect(
        currents.normalize({ id: "x", author: "Beth Harris, The Associated Press; Beth Harris; Feedloaderapi" })
          .creator
      ).toBe("Beth Harris, The Associated Press");
      expect(currents.normalize({ id: "x", author: "Feedloaderapi" }).creator).toBeNull();
      expect(currents.normalize({ id: "x" }).creator).toBeNull();
    });

    // Its classifier leaks working labels into `category`.
    test.each(["crap", "notsure", "redundant", "general", "news"])(
      "drops the classifier label %p from categories",
      (label) => {
        expect(currents.normalize({ id: "x", category: [label, "technology"] }).categories).toEqual(["technology"]);
      }
    );

    test('treats the literal string "None" as no image', () => {
      expect(currents.normalize({ id: "x", image: "None" }).image).toBeNull();
      expect(currents.normalize({ id: "x", image: "https://e/i.jpg" }).image).toBe("https://e/i.jpg");
    });

    test("reports no video, because Currents carries none", () => {
      expect(currents.normalize({ id: "x", video_url: "https://e/v.mp4" }).videoUrl).toBeNull();
    });
  });
});

describe("gnews provider", () => {
  // GNews refuses back-to-back requests, so fetchPage spaces them. Tests
  // must not actually sit through that gap.
  const noSleep = () => Promise.resolve();

  const arts = (start, n) =>
    ok({
      totalArticles: 100,
      articles: Array.from({ length: n }, (_, k) => ({
        id: `g${start + k}`,
        title: `Story ${start + k}`,
        url: `https://e/${start + k}`,
        description: "D",
        publishedAt: "2026-09-20T14:15:54Z",
        source: { id: "s1", name: "KitGuru" }
      }))
    });

  test("assembles a 20-item page from two 10-item responses", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(arts(0, 10)).mockResolvedValueOnce(arts(10, 10));
    const res = await gnews.fetchPage({ apiKey: "K", topic: "technology", language: "en", skip: 0, delay: noSleep });
    expect(res.articles).toHaveLength(20);
    expect(res.articles[0].id).toBe("gn_g0");
  });

  test("maps politics to its own 'nation' category", async () => {
    global.fetch = jest.fn().mockResolvedValue(arts(0, 10));
    await gnews.fetchPage({ apiKey: "K", topic: "politics", language: "en", skip: 0 });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("category")).toBe("nation");
  });

  test("refuses a topic it cannot serve, so the chain moves on", async () => {
    global.fetch = jest.fn();
    await expect(gnews.fetchPage({ apiKey: "K", topic: "food", language: "en", skip: 0 })).rejects.toMatchObject({
      status: 404
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("a search uses the search endpoint", async () => {
    global.fetch = jest.fn().mockResolvedValue(arts(0, 10));
    await gnews.fetchPage({ apiKey: "K", query: "ai", language: "en", skip: 0 });
    expect(String(global.fetch.mock.calls[0][0])).toContain("/search");
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("q")).toBe("ai");
  });

  test("surfaces its errors array", async () => {
    global.fetch = jest.fn().mockResolvedValue(fail(403, { errors: ["too many requests"] }));
    await expect(gnews.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).rejects.toThrow(
      "too many requests"
    );
  });

  test("a 200 carrying errors is still a failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ errors: ["blocked"] }) });
    await expect(gnews.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).rejects.toMatchObject({
      status: 429
    });
  });

  test("a network failure becomes a 502", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(gnews.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).rejects.toMatchObject({
      status: 502
    });
  });

  test("requires an API key", async () => {
    await expect(gnews.fetchPage({ topic: "top", language: "en", skip: 0 })).rejects.toMatchObject({ status: 401 });
  });

  test("has no single-article endpoint", async () => {
    expect(await gnews.getArticleById("K", "g1")).toBeNull();
  });

  test("serves a repeat request from cache without asking again", async () => {
    global.fetch = jest.fn().mockResolvedValue(arts(0, 10));
    await gnews.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 });
    global.fetch.mockClear();
    await gnews.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("falls back to a generic message when the body is not JSON", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      }
    });
    await expect(gnews.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).rejects.toThrow(
      "GNews returned HTTP 503"
    );
  });

  test("omits parameters it has no value for", async () => {
    global.fetch = jest.fn().mockResolvedValue(arts(0, 10));
    await gnews.fetchPage({ apiKey: "K", topic: "top", language: undefined, skip: 0 });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.has("lang")).toBe(false);
  });

  test("a malformed articles field yields an empty page", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ articles: "nonsense" }));
    expect((await gnews.fetchPage({ apiKey: "K", topic: "top", language: "en", skip: 0 })).articles).toEqual([]);
  });

  test("normalize maps its nested source and reports no video", () => {
    const n = gnews.normalize({
      id: "g1",
      title: "T",
      description: "D",
      url: "https://e/1",
      image: "https://e/i.jpg",
      publishedAt: "2026-09-20T14:15:54Z",
      source: { id: "s1", name: "KitGuru" }
    });
    expect(n.sourceName).toBe("KitGuru");
    expect(n.sourceId).toBe("s1");
    expect(n.videoUrl).toBeNull();
    expect(n.provider).toBe("gnews");
    expect(gnews.normalize({ id: "x" }).sourceName).toBe("Unknown source");
  });

  // Measured: the second of a pair sent with no gap is refused, while the
  // same pair a second apart both succeed. Without spacing them GNews could
  // never serve a full 20-article page.
  test("spaces its two requests, so a full page is reachable at all", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(arts(0, 10)).mockResolvedValueOnce(arts(10, 10));
    const delay = jest.fn().mockResolvedValue(undefined);
    const res = await gnews.fetchPage({ apiKey: "K", topic: "technology", language: "en", skip: 0, delay });
    expect(res.articles).toHaveLength(20);
    expect(delay).toHaveBeenCalledWith(gnews.INTER_PAGE_DELAY_MS);
  });

  test("the gap has margin over the measured threshold", () => {
    expect(gnews.INTER_PAGE_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });

  test("the fresher providers need no gap at all", () => {
    expect(newsdata.INTER_PAGE_DELAY_MS).toBeUndefined();
    expect(currents.INTER_PAGE_DELAY_MS).toBeUndefined();
  });

  test("is flagged as delayed, so the configure page can warn about it", () => {
    expect(gnews.delayed).toBe(true);
    expect(gnews.notes).toMatch(/12 hours/);
  });
});
