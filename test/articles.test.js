const {
  decodeEntities,
  realText,
  makeArticleId,
  isLowQuality,
  assembleCatalogPage,
  CATALOG_PAGE_SIZE,
  LOW_QUALITY_SOURCE_PRIORITY
} = require("../src/articles");

describe("decodeEntities — publishers hand these APIs escaped text", () => {
  test.each([
    ["telco &amp; isp", "telco & isp"],
    ["AT&amp;T earnings", "AT&T earnings"],
    ["it&#39;s here", "it's here"],
    ["&quot;quoted&quot;", '"quoted"'],
    ["caf&#233;", "café"],
    ["&lt;tag&gt;", "<tag>"],
    ["&#x2014; dash", "— dash"],
    ["a&nbsp;b", "a b"]
  ])("decodes %p to %p", (raw, decoded) => {
    expect(decodeEntities(raw)).toBe(decoded);
  });

  test.each(["&notanentity; kept", "100% & rising", "plain text", "bare & ampersand", "&; empty"])(
    "leaves %p alone",
    (text) => {
      expect(decodeEntities(text)).toBe(text);
    }
  );

  test.each([["&#0;"], ["&#1114112;"], ["&#xD800;"], ["&#xFFFFFFF;"]])(
    "refuses the out-of-range reference %p rather than throwing",
    (raw) => {
      expect(() => decodeEntities(raw)).not.toThrow();
      expect(decodeEntities(raw)).toBe(raw);
    }
  );

  test("decodes once, so an escaped entity is not unwrapped twice", () => {
    expect(decodeEntities("&amp;amp;")).toBe("&amp;");
  });
});

describe("realText — free-tier upsell placeholders", () => {
  test.each([
    "ONLY AVAILABLE IN PAID PLANS",
    "ONLY AVAILABLE IN PROFESSIONAL AND CORPORATE PLANS",
    "only available in paid plans",
    "  ONLY AVAILABLE IN PAID PLANS  "
  ])("%p is treated as no text at all", (placeholder) => {
    expect(realText(placeholder)).toBe("");
  });

  test("a sentence that merely mentions a plan is kept", () => {
    const real = "The company said only available seats in paid plans would remain.";
    expect(realText(real)).toBe(real);
  });

  test("trims, decodes, and rejects non-strings", () => {
    expect(realText("  hi  ")).toBe("hi");
    expect(realText("a &amp; b")).toBe("a & b");
    expect(realText(null)).toBe("");
    expect(realText(42)).toBe("");
    expect(realText("")).toBe("");
  });
});

describe("makeArticleId", () => {
  test("uses the provider's own id behind its prefix", () => {
    expect(makeArticleId("nd_", { id: "abc" })).toBe("nd_abc");
    expect(makeArticleId("cu_", { id: "abc" })).toBe("cu_abc");
  });

  test("the same story always yields the same id in the fallback path", () => {
    const raw = { link: "https://e.com/s", title: "T" };
    expect(makeArticleId("gn_", raw)).toBe(makeArticleId("gn_", { ...raw }));
  });

  test("different stories get different ids", () => {
    expect(makeArticleId("nd_", { link: "https://a/1" })).not.toBe(makeArticleId("nd_", { link: "https://a/2" }));
  });

  test("the fallback id is URL-safe", () => {
    const id = makeArticleId("nd_", { link: "https://e.com/a?b=c&d=e/f+g" });
    expect(id.slice(3)).not.toMatch(/[+/=]/);
  });

  test("does not throw on a story with nothing to hash", () => {
    expect(makeArticleId("nd_", {})).toBe("nd_");
  });
});

describe("isLowQuality — what these APIs will not flag", () => {
  test.each([
    ["a content farm", 99999999, true],
    ["a stock-spam aggregator", 5143682, true],
    ["just over the line", LOW_QUALITY_SOURCE_PRIORITY + 1, true],
    ["exactly on the line", LOW_QUALITY_SOURCE_PRIORITY, false],
    ["a minor real publisher", 1200410, false],
    ["CNN", 165, false]
  ])("%s (priority %p) -> dropped=%p", (_l, sourcePriority, expected) => {
    expect(isLowQuality({ title: "T", description: "D", sourcePriority })).toBe(expected);
  });

  test("a provider that reports no priority is never dropped for it", () => {
    expect(isLowQuality({ title: "T", sourcePriority: null })).toBe(false);
    expect(isLowQuality({ title: "T" })).toBe(false);
  });

  test.each([
    "Power outages happen—save up to 57% on EcoFlow power stations",
    "The best deals on laptops this weekend",
    "Deal of the day: headphones",
    "Grab this coupon code",
    "Shop now and save",
    "Prime Day deals you can still get"
  ])("drops the retail post %p", (title) => {
    expect(isLowQuality({ title })).toBe(true);
  });

  test("catches an ad embedded in the description", () => {
    expect(
      isLowQuality({ title: "How to watch the game", description: "Stream DIRECTV & save up to $30 off" })
    ).toBe(true);
  });

  test.each([
    "Government cuts rail fares by 50% from Monday",
    "Retailer reports a 30% fall in profit",
    "Shoppers spent less this Black Friday, data shows"
  ])("keeps genuine reporting: %p", (title) => {
    expect(isLowQuality({ title })).toBe(false);
  });

  test("a story with no text is judged on its source alone", () => {
    expect(isLowQuality({})).toBe(false);
    expect(isLowQuality({ sourcePriority: 99999999 })).toBe(true);
  });
});

describe("assembleCatalogPage — skip is an absolute item offset", () => {
  const art = (n) => ({ id: `a${n}`, title: `Story ${n}` });
  // A provider whose pages hold `size` articles, `total` in all.
  const pager = (size, total) => {
    const seen = [];
    const loadPage = async (index) => {
      seen.push(index);
      const start = index * size;
      if (start >= total) return { articles: [], hasMore: false };
      const n = Math.min(size, total - start);
      return { articles: Array.from({ length: n }, (_, k) => art(start + k)), hasMore: start + n < total };
    };
    return { loadPage, seen };
  };

  test("a catalog page is 20 articles built from 10-article pages", async () => {
    const p = pager(10, 200);
    const res = await assembleCatalogPage({ skip: 0, upstreamPageSize: 10, loadPage: p.loadPage });
    expect(res.articles).toHaveLength(CATALOG_PAGE_SIZE);
    expect(p.seen).toEqual([0, 1]);
  });

  test("a 20-article provider needs exactly one call", async () => {
    const p = pager(20, 200);
    const res = await assembleCatalogPage({ skip: 0, upstreamPageSize: 20, loadPage: p.loadPage });
    expect(res.articles).toHaveLength(20);
    expect(p.seen).toEqual([0]);
  });

  test.each([
    [0, "a0", 10],
    [20, "a20", 10],
    [40, "a40", 10],
    [0, "a0", 20],
    [20, "a20", 20],
    [60, "a60", 20]
  ])("skip=%p starts at %p with a page size of %p", async (skip, firstId, size) => {
    const p = pager(size, 500);
    const res = await assembleCatalogPage({ skip, upstreamPageSize: size, loadPage: p.loadPage });
    expect(res.articles[0].id).toBe(firstId);
    expect(res.articles).toHaveLength(20);
  });

  // Regression: skip used to be divided by the page size and floored, so an
  // offset that did not land on a boundary silently re-served an earlier page.
  test.each([5, 13, 27])("a skip of %p that is not on a page boundary is honoured exactly", async (skip) => {
    const p = pager(10, 500);
    const res = await assembleCatalogPage({ skip, upstreamPageSize: 10, loadPage: p.loadPage });
    expect(res.articles[0].id).toBe(`a${skip}`);
    expect(res.articles).toHaveLength(20);
  });

  test("three sequential pages yield 60 distinct stories", async () => {
    const p = pager(10, 500);
    const ids = [];
    for (const skip of [0, 20, 40]) {
      const res = await assembleCatalogPage({ skip, upstreamPageSize: 10, loadPage: p.loadPage });
      ids.push(...res.articles.map((a) => a.id));
    }
    expect(new Set(ids).size).toBe(60);
  });

  test.each([
    ["a negative skip", -50],
    ["a non-numeric skip", "abc"],
    ["an undefined skip", undefined],
    ["a null skip", null]
  ])("%s is treated as the first page", async (_l, skip) => {
    const p = pager(10, 100);
    const res = await assembleCatalogPage({ skip, upstreamPageSize: 10, loadPage: p.loadPage });
    expect(res.articles[0].id).toBe("a0");
  });

  test("a fractional skip is floored", async () => {
    const p = pager(10, 100);
    const res = await assembleCatalogPage({ skip: 20.9, upstreamPageSize: 10, loadPage: p.loadPage });
    expect(res.articles[0].id).toBe("a20");
  });

  test("stops early and reports no more when the feed runs out", async () => {
    const p = pager(10, 14);
    const res = await assembleCatalogPage({ skip: 0, upstreamPageSize: 10, loadPage: p.loadPage });
    expect(res.articles).toHaveLength(14);
    expect(res.hasMore).toBe(false);
  });

  test("a page the provider cannot reach is reported as truncated", async () => {
    const res = await assembleCatalogPage({ skip: 500, upstreamPageSize: 10, loadPage: async () => null });
    expect(res.articles).toEqual([]);
    expect(res.truncated).toBe(true);
  });

  test("never repeats a story within one page", async () => {
    const loadPage = async (i) =>
      i === 0
        ? { articles: [art(1), art(2)], hasMore: true }
        : { articles: [art(2), art(3)], hasMore: false };
    const res = await assembleCatalogPage({ skip: 0, upstreamPageSize: 10, loadPage });
    expect(res.articles.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });

  // Filtering after the slice keeps each page mapped to a fixed span of
  // upstream results; filtering first would make pages drift and overlap.
  test("filtering low quality never makes two pages overlap", async () => {
    const loadPage = async (index) => ({
      articles: Array.from({ length: 10 }, (_, k) => ({
        id: `a${index * 10 + k}`,
        title: k % 3 === 0 ? "Best deals of the week" : `Story ${index * 10 + k}`
      })),
      hasMore: true
    });
    const p1 = await assembleCatalogPage({ skip: 0, upstreamPageSize: 10, loadPage });
    const p2 = await assembleCatalogPage({ skip: 20, upstreamPageSize: 10, loadPage });
    const first = new Set(p1.articles.map((a) => a.id));
    expect(p2.articles.filter((a) => first.has(a.id))).toEqual([]);
    expect(p1.articles.length).toBeLessThan(CATALOG_PAGE_SIZE);
    expect(p1.articles.every((a) => !/best deals/i.test(a.title))).toBe(true);
  });
});
