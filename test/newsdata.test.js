const { clearAllCaches, articleCache } = require("../src/cache");
const {
  fetchNews,
  getArticleById,
  normalizeArticle,
  makeArticleId,
  PAGE_SIZE,
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
      sourceIcon: "https://e.com/ico.png",
      category: "technology",
      creator: "Jane, John"
    });
  });

  test("falls back to content when description is absent", () => {
    expect(normalizeArticle({ article_id: "x", content: "body text" }).description).toBe("body text");
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
  });
});

describe("fetchNews", () => {
  test("rejects with 401 when no apiKey is given", async () => {
    await expect(fetchNews({ apiKey: "", category: "top" })).rejects.toMatchObject({ status: 401 });
  });

  test("fetches page 0 and returns normalized articles", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1", { video_url: "https://v/1.mp4" })], nextPage: null }));
    const res = await fetchNews({ apiKey: "k", category: "technology", language: "en", skip: 0 });
    expect(res.articles).toHaveLength(1);
    expect(res.articles[0].id).toBe("nd_a1");
    expect(res.articles[0].videoUrl).toBe("https://v/1.mp4");
    expect(res.hasMore).toBe(false);
    expect(res.truncated).toBe(false);
  });

  test("sends apikey, language and category as query params", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [], nextPage: null }));
    await fetchNews({ apiKey: "KEY", category: "technology", language: "de", skip: 0 });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://newsdata.io/api/1/latest");
    expect(url.searchParams.get("apikey")).toBe("KEY");
    expect(url.searchParams.get("language")).toBe("de");
    expect(url.searchParams.get("category")).toBe("technology");
  });

  test("defaults to English when no language is supplied", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [], nextPage: null }));
    await fetchNews({ apiKey: "k", category: "top" });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("language")).toBe("en");
  });

  test("uses q instead of category for a search query", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [], nextPage: null }));
    await fetchNews({ apiKey: "k", query: "ai chips", language: "en", skip: 0 });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("ai chips");
    expect(url.searchParams.has("category")).toBe(false);
  });

  test("reports hasMore when upstream has a next page", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: "TOK" }));
    expect((await fetchNews({ apiKey: "k", category: "top" })).hasMore).toBe(true);
  });

  test("tolerates a malformed results payload", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: "not-an-array", nextPage: null }));
    expect((await fetchNews({ apiKey: "k", category: "top" })).articles).toEqual([]);
  });

  test("caches a page so a repeat request makes no second network call", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    await fetchNews({ apiKey: "k", category: "top", language: "en", skip: 0 });
    await fetchNews({ apiKey: "k", category: "top", language: "en", skip: 0 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("caches per query: a different topic is fetched separately", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    await fetchNews({ apiKey: "k", category: "top", language: "en" });
    await fetchNews({ apiKey: "k", category: "technology", language: "en" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("caches per language: the same topic in another language is fetched separately", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    await fetchNews({ apiKey: "k", category: "top", language: "en" });
    await fetchNews({ apiKey: "k", category: "top", language: "fr" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("walks the cursor chain to reach a later page via skip", async () => {
    const page0 = { results: [article("a1"), article("a2")], nextPage: "TOKEN_1" };
    const page1 = { results: [article("a3")], nextPage: null };
    global.fetch = jest.fn((u) =>
      Promise.resolve(ok(new URL(u).searchParams.get("page") === "TOKEN_1" ? page1 : page0))
    );

    const first = await fetchNews({ apiKey: "k", category: "top", skip: 0 });
    expect(first.articles.map((a) => a.id)).toEqual(["nd_a1", "nd_a2"]);

    const second = await fetchNews({ apiKey: "k", category: "top", skip: PAGE_SIZE });
    expect(second.articles.map((a) => a.id)).toEqual(["nd_a3"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("passes the opaque cursor token upstream as the page param", async () => {
    const page0 = { results: [article("a1")], nextPage: "TOKEN_1" };
    const page1 = { results: [article("a2")], nextPage: null };
    global.fetch = jest.fn((u) =>
      Promise.resolve(ok(new URL(u).searchParams.get("page") === "TOKEN_1" ? page1 : page0))
    );
    await fetchNews({ apiKey: "k", category: "top", skip: 0 });
    await fetchNews({ apiKey: "k", category: "top", skip: PAGE_SIZE });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.has("page")).toBe(false);
    expect(new URL(global.fetch.mock.calls[1][0]).searchParams.get("page")).toBe("TOKEN_1");
  });

  test("reuses cached intermediate cursors instead of re-walking from page 0", async () => {
    const pages = {
      none: { results: [article("a1")], nextPage: "T1" },
      T1: { results: [article("a2")], nextPage: "T2" },
      T2: { results: [article("a3")], nextPage: null }
    };
    global.fetch = jest.fn((u) => Promise.resolve(ok(pages[new URL(u).searchParams.get("page") || "none"])));

    await fetchNews({ apiKey: "k", category: "top", skip: 0 });
    await fetchNews({ apiKey: "k", category: "top", skip: PAGE_SIZE });
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const third = await fetchNews({ apiKey: "k", category: "top", skip: PAGE_SIZE * 2 });
    expect(third.articles.map((a) => a.id)).toEqual(["nd_a3"]);
    expect(global.fetch).toHaveBeenCalledTimes(3); // only the one new page
  });

  test("a mid-scroll skip lands on the right page without refetching earlier ones", async () => {
    const pages = {
      none: { results: [article("a1")], nextPage: "T1" },
      T1: { results: [article("a2")], nextPage: "T2" },
      T2: { results: [article("a3")], nextPage: null }
    };
    global.fetch = jest.fn((u) => Promise.resolve(ok(pages[new URL(u).searchParams.get("page") || "none"])));
    await fetchNews({ apiKey: "k", category: "top", skip: 0 });
    global.fetch.mockClear();
    const res = await fetchNews({ apiKey: "k", category: "top", skip: PAGE_SIZE * 2 });
    expect(res.articles.map((a) => a.id)).toEqual(["nd_a3"]);
    expect(global.fetch).toHaveBeenCalledTimes(2); // pages 1 and 2 only
  });

  test("a non-multiple skip resolves to the containing page", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    const res = await fetchNews({ apiKey: "k", category: "top", skip: 3 }); // still page 0
    expect(res.articles.map((a) => a.id)).toEqual(["nd_a1"]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("a negative skip is clamped to page 0", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    expect((await fetchNews({ apiKey: "k", category: "top", skip: -50 })).articles).toHaveLength(1);
  });

  test("returns an empty truncated page when skip is deeper than MAX_PAGE_WALK allows", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: "MORE" }));
    const res = await fetchNews({ apiKey: "k", category: "top", skip: PAGE_SIZE * (MAX_PAGE_WALK + 5) });
    expect(res.articles).toEqual([]);
    expect(res.truncated).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled(); // refuses to burn the rate limit
  });

  test("stops gracefully when upstream runs out of pages mid-walk", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    const res = await fetchNews({ apiKey: "k", category: "top", skip: PAGE_SIZE });
    expect(res.articles).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  test("wraps a network failure as a 502", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(fetchNews({ apiKey: "k", category: "top" })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("boom")
    });
  });

  test("propagates an upstream HTTP error with its status and message", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ results: { message: "rate limit exceeded" } })
    });
    await expect(fetchNews({ apiKey: "k", category: "top" })).rejects.toMatchObject({
      status: 429,
      message: "rate limit exceeded"
    });
  });

  test("reads a top-level error message when there is no results.message", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: "invalid api key" })
    });
    await expect(fetchNews({ apiKey: "bad", category: "top" })).rejects.toMatchObject({ message: "invalid api key" });
  });

  test("falls back to a generic message when the error body is not JSON", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json"); }
    });
    await expect(fetchNews({ apiKey: "k", category: "top" })).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("500")
    });
  });

test("falls back to a generic message when the error body is null", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => null });
    await expect(fetchNews({ apiKey: "k", category: "top" })).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("503")
    });
  });

  test("falls back safely if the freshly-cached page cannot be read back", async () => {
    // Defensive path: guards against the page being evicted between write and read.
    const cache = require("../src/cache");
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    jest.spyOn(cache.catalogCache, "get").mockReturnValue(undefined);
    const res = await fetchNews({ apiKey: "k", category: "top" });
    expect(res).toEqual({ articles: [], hasMore: false, truncated: false });
  });

  test("populates the article cache as a side effect of a catalog fetch", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    await fetchNews({ apiKey: "k", category: "top" });
    expect(articleCache.get("nd_a1")).toMatchObject({ id: "nd_a1" });
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
