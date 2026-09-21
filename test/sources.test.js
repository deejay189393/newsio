const { clearAllCaches, articleCache, sourceCooldownCache } = require("../src/cache");
const { fetchCatalogPage, getArticle, usableSources, isExhausted, markExhausted, isOnCooldown } = require("../src/sources");
const currents = require("../src/providers/currents");
const newsdata = require("../src/providers/newsdata");
const gnews = require("../src/providers/gnews");

beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

const CUR = { provider: "currents", apiKey: "cur-key" };
const ND = { provider: "newsdata", apiKey: "nd-key" };
const GN = { provider: "gnews", apiKey: "gn-key" };

const err = (status, message = "boom") => Object.assign(new Error(message), { status });
const pageOf = (prefix, n = 20) => ({
  articles: Array.from({ length: n }, (_, k) => ({ id: `${prefix}${k}`, title: `S${k}` })),
  hasMore: true,
  truncated: false
});

/** Make a provider answer, or fail, without touching the network. */
function stub(provider, impl) {
  return jest.spyOn(provider, "fetchPage").mockImplementation(impl);
}

describe("isExhausted — which failures mean 'try the next source'", () => {
  test.each([
    ["a rate limit", 429, "", true],
    ["a rejected key", 401, "", true],
    ["a forbidden key", 403, "", true],
    ["a quota conflict", 409, "", true],
    ["an upstream outage", 500, "", true],
    ["a gateway failure", 502, "", true],
    ["an unsupported topic", 404, "", false],
    ["a malformed request", 400, "", false],
    ["a rate limit named only in the message", undefined, "Rate limit exceeded", true],
    ["a quota named only in the message", undefined, "Monthly quota reached", true],
    ["an ordinary error", undefined, "something odd", false]
  ])("%s -> %p", (_l, status, message, expected) => {
    expect(isExhausted(err(status, message))).toBe(expected);
  });
});

describe("choosing which sources to try", () => {
  test("keeps the user's order — that order is the failover chain", () => {
    expect(usableSources([GN, CUR, ND], { topic: "technology" }).map((s) => s.provider.id)).toEqual([
      "gnews",
      "currents",
      "newsdata"
    ]);
  });

  test("skips a source with no key, and an unknown provider", () => {
    const sources = [{ provider: "currents", apiKey: "" }, { provider: "nope", apiKey: "k" }, ND];
    expect(usableSources(sources, { topic: "top" }).map((s) => s.provider.id)).toEqual(["newsdata"]);
  });

  test("skips a provider that has no category for the topic", () => {
    // GNews has nothing for Crime; asking it would waste a request.
    expect(usableSources([GN, ND], { topic: "crime" }).map((s) => s.provider.id)).toEqual(["newsdata"]);
  });

  test("a search is free text, so every provider can attempt it", () => {
    expect(usableSources([GN, CUR, ND], { query: "ai" }).map((s) => s.provider.id)).toEqual([
      "gnews",
      "currents",
      "newsdata"
    ]);
  });

  test("skips a source that is cooling off", () => {
    markExhausted(CUR, "rate limited");
    expect(isOnCooldown(CUR)).toBe(true);
    expect(usableSources([CUR, ND], { topic: "top" }).map((s) => s.provider.id)).toEqual(["newsdata"]);
  });

  test("the cooldown is per key, not per provider", () => {
    markExhausted(CUR, "rate limited");
    expect(isOnCooldown({ provider: "currents", apiKey: "a-different-key" })).toBe(false);
  });

  test.each([[undefined], [null], [[]]])("%p yields no sources rather than throwing", (sources) => {
    expect(usableSources(sources, { topic: "top" })).toEqual([]);
  });
});

describe("fetchCatalogPage — failover", () => {
  test("uses the first source when it answers", async () => {
    const c = stub(currents, async () => pageOf("cu_"));
    const n = stub(newsdata, async () => pageOf("nd_"));
    const res = await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 0 });
    expect(res.provider).toBe("currents");
    expect(res.articles).toHaveLength(20);
    expect(c).toHaveBeenCalled();
    expect(n).not.toHaveBeenCalled();
  });

  test("falls through to the next source when the first is rate-limited", async () => {
    stub(currents, async () => {
      throw err(429, "Rate limit exceeded");
    });
    stub(newsdata, async () => pageOf("nd_"));
    const res = await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 0 });
    expect(res.provider).toBe("newsdata");
    expect(res.articles[0].id).toBe("nd_0");
  });

  test("keeps falling through until one answers", async () => {
    stub(currents, async () => {
      throw err(429);
    });
    stub(newsdata, async () => {
      throw err(401);
    });
    stub(gnews, async () => pageOf("gn_"));
    const res = await fetchCatalogPage([CUR, ND, GN], { topic: "technology", language: "en", skip: 0 });
    expect(res.provider).toBe("gnews");
  });

  test("an empty first page yields to a source that has stories", async () => {
    stub(currents, async () => ({ articles: [], hasMore: false, truncated: false }));
    stub(newsdata, async () => pageOf("nd_"));
    const res = await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 0 });
    expect(res.provider).toBe("newsdata");
  });

  // On a deeper page an empty result is the honest end of the feed. Failing
  // over there would splice another source's page 1 onto this one's page 3,
  // repeating stories the reader has already scrolled past.
  test("an empty later page is the end of the feed, not a reason to fail over", async () => {
    stub(currents, async () => ({ articles: [], hasMore: false, truncated: false }));
    const n = stub(newsdata, async () => pageOf("nd_"));
    const res = await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 40 });
    expect(res.articles).toEqual([]);
    expect(res.provider).toBe("currents");
    expect(n).not.toHaveBeenCalled();
  });

  test("a spent source is put on cooldown so it is not retried next request", async () => {
    stub(currents, async () => {
      throw err(429, "Rate limit exceeded");
    });
    const n = stub(newsdata, async () => pageOf("nd_"));
    await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 0 });
    expect(isOnCooldown(CUR)).toBe(true);

    currents.fetchPage.mockClear();
    n.mockClear();
    await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 20 });
    expect(currents.fetchPage).not.toHaveBeenCalled();
    expect(n).toHaveBeenCalled();
  });

  // A malformed request to one API says nothing about the next, so the chain
  // continues -- but that key is not branded as spent.
  test("a non-quota error moves on without a cooldown", async () => {
    stub(currents, async () => {
      throw err(400, "bad request");
    });
    stub(newsdata, async () => pageOf("nd_"));
    const res = await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 0 });
    expect(res.provider).toBe("newsdata");
    expect(isOnCooldown(CUR)).toBe(false);
  });

  test("when every source fails the shelf is empty rather than broken", async () => {
    stub(currents, async () => {
      throw err(429);
    });
    stub(newsdata, async () => {
      throw err(429);
    });
    const res = await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 0 });
    expect(res.articles).toEqual([]);
    expect(res.provider).toBeNull();
    expect(res.attempts).toHaveLength(2);
    expect(console.error).toHaveBeenCalled();
  });

  test("no configured sources yields an empty page", async () => {
    const res = await fetchCatalogPage([], { topic: "technology", language: "en", skip: 0 });
    expect(res.articles).toEqual([]);
    expect(res.provider).toBeNull();
  });

  test("reports which sources were tried, for diagnosis", async () => {
    stub(currents, async () => {
      throw err(429, "Rate limit exceeded");
    });
    stub(newsdata, async () => pageOf("nd_"));
    const res = await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 0 });
    expect(res.attempts).toEqual([{ provider: "currents", outcome: "Rate limit exceeded" }]);
  });

  test("passes the topic, query, language and skip straight through", async () => {
    const c = stub(currents, async () => pageOf("cu_"));
    await fetchCatalogPage([CUR], { topic: "sports", query: "cup", language: "fr", skip: 40 });
    expect(c).toHaveBeenCalledWith({ apiKey: "cur-key", topic: "sports", query: "cup", language: "fr", skip: 40 });
  });

  test("a truncated page is a real answer, not a reason to fail over", async () => {
    stub(currents, async () => ({ articles: [], hasMore: false, truncated: true }));
    const n = stub(newsdata, async () => pageOf("nd_"));
    const res = await fetchCatalogPage([CUR, ND], { topic: "technology", language: "en", skip: 0 });
    expect(res.provider).toBe("currents");
    expect(n).not.toHaveBeenCalled();
  });
});

describe("getArticle — resolving one story", () => {
  test("the cache answers first, without asking anyone", async () => {
    articleCache.set("cu_1", { id: "cu_1", title: "Cached" });
    const c = jest.spyOn(currents, "getArticleById");
    expect((await getArticle([CUR], "cu_1")).title).toBe("Cached");
    expect(c).not.toHaveBeenCalled();
  });

  test("asks only the provider whose prefix the id carries", async () => {
    const n = jest.spyOn(newsdata, "getArticleById").mockResolvedValue({ id: "nd_1", title: "From newsdata" });
    const c = jest.spyOn(currents, "getArticleById");
    const article = await getArticle([CUR, ND], "nd_1");
    expect(article.title).toBe("From newsdata");
    expect(n).toHaveBeenCalledWith("nd-key", "1");
    expect(c).not.toHaveBeenCalled();
  });

  test("an id from an unknown provider resolves to null", async () => {
    expect(await getArticle([CUR, ND], "zz_1")).toBeNull();
  });

  test("an id whose provider is not configured resolves to null", async () => {
    expect(await getArticle([CUR], "nd_1")).toBeNull();
  });

  // Currents and GNews have no single-article endpoint, so an item opened
  // long after its catalog page aged out simply cannot be resolved.
  test("a provider with no lookup endpoint resolves to null", async () => {
    expect(await getArticle([CUR], "cu_never-seen")).toBeNull();
  });

  test("a lookup failure resolves to null and cools the source down", async () => {
    jest.spyOn(newsdata, "getArticleById").mockRejectedValue(err(429, "Rate limit exceeded"));
    expect(await getArticle([ND], "nd_1")).toBeNull();
    expect(isOnCooldown(ND)).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  test("a non-quota lookup failure does not cool the source down", async () => {
    jest.spyOn(newsdata, "getArticleById").mockRejectedValue(err(400, "bad id"));
    expect(await getArticle([ND], "nd_1")).toBeNull();
    expect(isOnCooldown(ND)).toBe(false);
  });

  test.each([[undefined], [null], [[]]])("%p sources resolves to null", async (sources) => {
    expect(await getArticle(sources, "nd_1")).toBeNull();
  });
});

describe("defaults", () => {
  test("a cooldown with no stated reason still records one", () => {
    markExhausted(CUR);
    expect(isOnCooldown(CUR)).toBe(true);
    expect(sourceCooldownCache.get("currents::ur-key")).toBe("unavailable");
  });

  test("skip defaults to the first page when the caller omits it", async () => {
    const c = jest.spyOn(currents, "fetchPage").mockResolvedValue(pageOf("cu_"));
    await fetchCatalogPage([CUR], { topic: "technology", language: "en" });
    expect(c).toHaveBeenCalledWith(expect.objectContaining({ skip: 0 }));
  });
});

describe("the cooldown store", () => {
  test("expires, so a recovered key comes back into rotation", () => {
    markExhausted(CUR, "rate limited");
    expect(isOnCooldown(CUR)).toBe(true);
    sourceCooldownCache.clear();
    expect(isOnCooldown(CUR)).toBe(false);
  });
});
