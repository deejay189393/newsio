const { clearAllCaches, articleCache } = require("../src/cache");
const nm = require("../src/providers/newsmcp");
const registry = require("../src/providers");

beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

const headersOf = (h = {}) => ({ get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) });
const ok = (body) => ({ ok: true, status: 200, headers: headersOf(), json: async () => body });
const fail = (status, body, headers) => ({ ok: false, status, headers: headersOf(headers), json: async () => body });
const notJson = (status) => ({
  ok: status < 400,
  status,
  headers: headersOf(),
  json: async () => {
    throw new Error("Unexpected token <");
  }
});

// Headlines distinct enough that the duplicate collapse leaves them alone.
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
const headline = (n) => `Story ${WORDS[n % 10]}${n} ${WORDS[(n * 3) % 10]}x${n}`;

const event = (n, extra = {}) => ({
  event_id: `evt_${n}`,
  headline: headline(n),
  abstract: `Abstract ${n}`,
  first_seen: "2026-09-20T10:00:00",
  last_seen: "2026-09-21T10:00:00",
  entities: [{ name: `Entity ${n}`, salience: 0.9 }],
  sources: [`https://www.outlet${n}.com/story/${n}`],
  sector: "sports_recreation",
  ...extra
});
const batch = (from, n) => ({ total: 999, events: Array.from({ length: n }, (_, k) => event(from + k)) });
const urlOf = (call) => new URL(call[0]);
const noWait = { wait: async () => {} };

describe("the provider as the registry sees it", () => {
  test("is registered second, after YouTube", () => {
    expect(registry.PROVIDERS[1]).toBe(nm);
    expect(registry.getProvider("newsmcp")).toBe(nm);
  });

  test("works without a key, in English only, with its own id prefix", () => {
    expect(nm.keyOptional).toBe(true);
    expect(nm.languages).toEqual(["en"]);
    expect(nm.idPrefix).toBe("nm_");
    expect(nm.supportsVideo).toBe(false);
    expect(registry.providerForArticleId("nm_evt_1")).toBe(nm);
  });

  test("points people at the real service, not the defunct .io one", () => {
    expect(nm.homepage).toBe("https://newsmcp.com");
    expect(nm.signupUrl).toBe("https://platform.newsmcp.com/auth");
    expect(nm.notes).toMatch(/No key needed/);
    expect(nm.notes).toMatch(/English only/);
  });

  test("maps every preset it can express, and only country and video are left out", () => {
    const unmapped = registry.TOPICS.filter((t) => !nm.categories[t.id]).map((t) => t.id);
    expect(unmapped).toEqual(["domestic", "video"]);
  });

  test("every feed ranks by trending, and top stories strip the press-release wire", () => {
    Object.values(nm.categories)
      .filter(Boolean)
      .forEach((filters) => expect(filters.sort).toBe("trending"));
    expect(nm.categories.top).toEqual({ sort: "trending", content_type: "news_report" });
  });

  test("science is discoveries only", () => {
    expect(nm.categories.science.event_type).toBe("research_science.scientific_discovery");
  });
});

describe("normalize — an event as an article", () => {
  test("maps every field the addon reads", () => {
    const article = nm.normalize({
      event_id: "evt_abc",
      headline: "German Bundesliga Kicks Off",
      abstract: "The opening matches &amp; results.",
      first_seen: "2026-09-19T16:36:47",
      last_seen: "2026-09-20T13:14:53",
      entities: [
        { name: "Bayern Munich", salience: 0.8 },
        { name: "German Bundesliga", salience: 0.9 }
      ],
      sources: ["https://www.nampa.org/text/1", "https://www.lanacion.com.ar/x", "https://vorsprung-online.de/y"],
      sector: "sports_recreation"
    });
    expect(article).toEqual({
      id: "nm_evt_abc",
      title: "German Bundesliga Kicks Off",
      description: "The opening matches & results.",
      link: "https://www.nampa.org/text/1",
      sources: [
        { name: "Nampa", url: "https://www.nampa.org/text/1" },
        { name: "Lanacion", url: "https://www.lanacion.com.ar/x" },
        { name: "Vorsprung-online", url: "https://vorsprung-online.de/y" }
      ],
      image: null,
      videoUrl: null,
      pubDate: "2026-09-20T13:14:53",
      sourceName: "Nampa",
      sourceId: null,
      sourcePriority: null,
      sourceIcon: null,
      categories: ["Sports"],
      keywords: ["German Bundesliga", "Bayern Munich"],
      creator: null,
      provider: "newsmcp"
    });
  });

  test("falls back to the one-liner, a placeholder title and the first-seen date", () => {
    const article = nm.normalize({ event_id: "e", one_liner: "Short.", first_seen: "2026-09-19T00:00:00", sources: ["https://a.com"] });
    expect(article.description).toBe("Short.");
    expect(article.title).toBe("Untitled");
    expect(article.pubDate).toBe("2026-09-19T00:00:00");
  });

  test("has no date rather than a wrong one when neither is given", () => {
    expect(nm.normalize({ event_id: "e", sources: ["https://a.com"] }).pubDate).toBeNull();
  });

  test("keeps only real web links as sources", () => {
    const article = nm.normalize({
      event_id: "e",
      sources: ["javascript:alert(1)", "ftp://files.example/x", 42, "not a url", "http://plain.example/story"]
    });
    expect(article.sources).toEqual([{ name: "Plain", url: "http://plain.example/story" }]);
  });

  test("with no usable source it has no link, and says who it came from", () => {
    for (const sources of [[], undefined, "https://a.com", ["mailto:x@y.z"]]) {
      const article = nm.normalize({ event_id: "e", sources });
      expect(article.link).toBeNull();
      expect(article.sources).toEqual([]);
      expect(article.sourceName).toBe("NewsMCP");
    }
  });

  test.each([["other_sector"], ["not_a_sector"], [undefined]])("sector %p gives no category tag", (sector) => {
    expect(nm.normalize({ event_id: "e", sector, sources: ["https://a.com"] }).categories).toEqual([]);
  });

  test("entity tags are ordered by salience, and junk entities are ignored", () => {
    const article = nm.normalize({
      event_id: "e",
      sources: ["https://a.com"],
      entities: [
        { name: "Low", salience: 0.1 },
        { name: "   " },
        { salience: 0.9 },
        null,
        { name: 7, salience: 1 },
        { name: "Unscored" },
        { name: "High", salience: 0.95 }
      ]
    });
    expect(article.keywords).toEqual(["High", "Low", "Unscored"]);
    expect(nm.normalize({ event_id: "e", sources: ["https://a.com"], entities: "nope" }).keywords).toEqual([]);
  });

  test("an event without an id still gets a stable id from its link", () => {
    const a = nm.normalize({ headline: "H", sources: ["https://a.com/1"] });
    const b = nm.normalize({ headline: "H", sources: ["https://a.com/1"] });
    expect(a.id).toBe(b.id);
    expect(a.id.startsWith("nm_")).toBe(true);
  });
});

describe("toSearch — plain English into the index's boolean syntax", () => {
  test.each([
    ['"Tim Cook"', { q: '"Tim Cook"' }],
    ["Apple AND NOT Samsung", { q: "Apple AND NOT Samsung" }],
    ["  Tesla   OR   Rivian ", { q: "Tesla OR Rivian" }]
  ])("written syntax is passed through untouched: %p", (text, expected) => {
    expect(nm.toSearch(text)).toEqual(expected);
  });

  test.each([
    ["London", { q: "London" }],
    ["Mumbai", { q: "Mumbai" }],
    ["Indian Cricket", { q: "Indian Cricket", relaxedQ: "Indian OR Cricket" }],
    ["Latest Netflix Movies & Reviews", { q: "Netflix Movies Reviews", relaxedQ: "Netflix OR Movies OR Reviews" }],
    ["Best New TV Shows in India", { q: "New TV Shows India", relaxedQ: "New OR TV OR Shows OR India" }],
    ["Anthropic, OpenAI, AI", { q: "Anthropic OR OpenAI OR AI" }],
    ["Indian Cricket, IPL", { q: "(Indian Cricket) OR IPL", relaxedQ: "Indian OR Cricket OR IPL" }],
    ["Tesla (earnings)!", { q: "Tesla earnings", relaxedQ: "Tesla OR earnings" }],
    ["Women's cricket.", { q: "Women's cricket", relaxedQ: "Women's OR cricket" }]
  ])("%p", (text, expected) => {
    expect(nm.toSearch(text)).toEqual(expected);
  });

  test("lower-case and/or/not are words, not operators", () => {
    expect(nm.toSearch("salt and pepper")).toEqual({ q: "salt pepper", relaxedQ: "salt OR pepper" });
  });

  test("'not' excludes the next real word, skipping the filler between", () => {
    expect(nm.toSearch("Top Stories (Not a lot of Trump)")).toEqual({ general: true, q: "NOT Trump" });
  });

  test.each([
    ["Cricket without Kohli", { q: "(Cricket) NOT Kohli" }],
    ["Indian Cricket except Kohli", { q: "(Indian Cricket) NOT Kohli", relaxedQ: "(Indian OR Cricket) NOT Kohli" }],
    ["F1 excluding Verstappen, not Hamilton", { q: "(F1) NOT Verstappen NOT Hamilton" }]
  ])("exclusions apply to the whole search: %p", (text, expected) => {
    expect(nm.toSearch(text)).toEqual(expected);
  });

  test("the same exclusion twice is written once", () => {
    expect(nm.toSearch("not Trump, not Trump")).toEqual({ general: true, q: "NOT Trump" });
  });

  test("a trailing 'not' with nothing after it is dropped", () => {
    expect(nm.toSearch("Cricket not")).toEqual({ q: "Cricket" });
  });

  test.each([["Top Stories"], ["Latest News"], ["the news, today"], [""], ["   "], [undefined], [42]])(
    "nothing to search for (%p) means the top-stories feed",
    (text) => {
      expect(nm.toSearch(text)).toEqual({ general: true });
    }
  );
});

describe("filtersFor — what one catalog request asks the API", () => {
  test("a preset topic asks for its own filters", () => {
    expect(nm.filtersFor({ topic: "sports" })).toEqual({ filters: nm.categories.sports, relaxedQ: null });
  });

  test.each([["domestic"], ["video"], ["nonsense"], [undefined]])("%p cannot be served", (topic) => {
    expect(nm.filtersFor({ topic })).toBeNull();
  });

  test("a query is a relevance-ranked search, with its relaxed form", () => {
    expect(nm.filtersFor({ query: "Indian Cricket" })).toEqual({
      filters: { q: "Indian Cricket" },
      relaxedQ: "Indian OR Cricket"
    });
    expect(nm.filtersFor({ query: "London" })).toEqual({ filters: { q: "London" }, relaxedQ: null });
  });

  test("a query of pure filler is the top-stories feed", () => {
    expect(nm.filtersFor({ query: "Top Stories" })).toEqual({ filters: nm.categories.top, relaxedQ: null });
  });

  test("...minus whatever it excludes", () => {
    expect(nm.filtersFor({ query: "Top Stories (Not a lot of Trump)" })).toEqual({
      filters: { ...nm.categories.top, q: "NOT Trump" },
      relaxedQ: null
    });
  });

  test("a query wins over a topic", () => {
    expect(nm.filtersFor({ topic: "sports", query: "London" }).filters).toEqual({ q: "London" });
  });
});

describe("collapseNearDuplicates — what the clustering missed", () => {
  const mk = (title, pubDate = "2026-09-20T12:00:00") => ({ id: `${title}|${pubDate}`, title, pubDate });
  const collapsed = (...articles) => nm.collapseNearDuplicates(articles).map((a) => a.id);

  // Every pair below was measured on a live batch.
  test.each([
    ["Brighton Beats Arsenal 3-0", "2026-09-20T12:42:00", "Brighton Defeats Arsenal 3-0", "2026-09-20T00:03:00"],
    ["Arsenal Loses to Brighton 3-0", "2026-09-21T13:54:00", "Brighton Beats Arsenal 3-0", "2026-09-20T12:42:00"],
    ["Brajton Defeats Arsenal 3-0", "2026-09-20T12:15:00", "Brighton Defeats Arsenal 3-0", "2026-09-20T00:03:00"],
    ["India Cricket Team Faces Jersey Issues", "2026-09-20T01:19:00", "India Cricket Team Faces Kit Issues", "2026-09-20T13:42:00"],
    [
      "India Announces Squad for West Indies Series",
      "2026-09-16T17:58:00",
      "India Announces Cricket Squad for West Indies Series",
      "2026-09-16T23:55:00"
    ]
  ])("the same story twice is shown once: %p / %p", (a, ta, b, tb) => {
    expect(collapsed(mk(a, ta), mk(b, tb))).toEqual([`${a}|${ta}`]);
  });

  test.each([
    ["India Announces Cricket Team", "India Women's Cricket Team Reaches Semifinals"],
    ["India Announces Cricket Team", "India Cricket Team Faces Jersey Issues"],
    ["India Announces Squad for West Indies Series", "India Announces T20I Squad"],
    ["Choo Ga-eun Wins Gold in Women's 10m Air Pistol", "South Korea Wins Silver in Women's 10m Air Pistol"],
    ["Arsenal Wins 1-0 Against HB Koge", "Arsenal Wins 2-0 Against Chelsea"]
  ])("different stories that share the searched words both stay: %p / %p", (a, b) => {
    expect(collapsed(mk(a), mk(b))).toHaveLength(2);
  });

  test("a recurring headline a week apart is two stories", () => {
    expect(collapsed(mk("Weekly Jobless Claims Fall", "2026-09-10T12:00:00"), mk("Weekly Jobless Claims Fall", "2026-09-17T12:00:00"))).toHaveLength(2);
  });

  test("an undated pair is judged on the words alone", () => {
    expect(collapsed(mk("Brighton Beats Arsenal 3-0", null), mk("Brighton Beats Arsenal 3-0", "2026-09-20T12:00:00"))).toHaveLength(1);
    expect(collapsed(mk("Brighton Beats Arsenal 3-0", "nonsense"), mk("Brighton Beats Arsenal 3-0"))).toHaveLength(1);
  });

  test("a date that already carries a zone is read as written", () => {
    expect(
      collapsed(mk("Weekly Jobless Claims Fall", "2026-09-10T12:00:00Z"), mk("Weekly Jobless Claims Fall", "2026-09-17T12:00:00+00:00"))
    ).toHaveLength(2);
  });

  test("keeps the first, which is the higher-ranked", () => {
    expect(collapsed(mk("Brighton Beats Arsenal 3-0"), mk("Brighton Defeats Arsenal 3-0"))).toEqual([
      "Brighton Beats Arsenal 3-0|2026-09-20T12:00:00"
    ]);
  });

  test("two short headlines need three shared words, not a high ratio", () => {
    expect(collapsed(mk("Arsenal Wins"), mk("Arsenal Wins"))).toHaveLength(2);
  });

  test("copes with a missing title", () => {
    expect(collapsed({ id: "a", title: undefined, pubDate: null }, { id: "b", title: "", pubDate: null })).toEqual(["a", "b"]);
  });
});

describe("fetchPage — a preset topic", () => {
  test("asks for that topic's filters, keyless, with an honest user agent", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 20)));
    const page = await nm.fetchPage({ apiKey: "", topic: "sports", skip: 0 });

    expect(page.articles).toHaveLength(20);
    const url = urlOf(fetchMock.mock.calls[0]);
    expect(url.origin + url.pathname).toBe("https://api.newsmcp.com/v0/news");
    expect(Object.fromEntries(url.searchParams)).toEqual({ sort: "trending", sector: "sports_recreation", limit: "20" });
    const { headers, signal } = fetchMock.mock.calls[0][1];
    expect(headers["user-agent"]).toBe("Newsio (+https://github.com/deejay189393/newsio)");
    expect(headers).not.toHaveProperty("x-api-key");
    expect(signal).toBeDefined();
  });

  test("with a key, sends it in the one header REST reads, and asks for 50", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 50)));
    await nm.fetchPage({ apiKey: "nmk_1", topic: "sports", skip: 0 });
    expect(urlOf(fetchMock.mock.calls[0]).searchParams.get("limit")).toBe("50");
    expect(urlOf(fetchMock.mock.calls[0]).searchParams.has("apiKey")).toBe(false);
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("nmk_1");
  });

  test("one keyed call serves two and a half pages, and then the feed ends", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 50)));
    const at = async (skip) => (await nm.fetchPage({ apiKey: "k", topic: "top", skip })).articles.map((a) => a.id);

    expect(await at(0)).toEqual(Array.from({ length: 20 }, (_, k) => `nm_evt_${k}`));
    expect(await at(20)).toEqual(Array.from({ length: 20 }, (_, k) => `nm_evt_${20 + k}`));
    expect(await at(40)).toEqual(Array.from({ length: 10 }, (_, k) => `nm_evt_${40 + k}`));
    expect(await at(60)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keyless, one call is the whole catalog", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 20)));
    await nm.fetchPage({ apiKey: "", topic: "top", skip: 0 });
    expect((await nm.fetchPage({ apiKey: "", topic: "top", skip: 20 })).articles).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a batch is kept for an hour, shared by everyone asking the same thing", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(ok(batch(0, 20)));
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);

    await nm.fetchPage({ apiKey: "", topic: "top", skip: 0 });
    clock.mockReturnValue(now + nm.BATCH_TTL_MS - 1000);
    await nm.fetchPage({ apiKey: "", topic: "top", skip: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(now + nm.BATCH_TTL_MS + 1000);
    await nm.fetchPage({ apiKey: "", topic: "top", skip: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("keyless and keyed batches are kept apart, since they differ in size", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 20))).mockResolvedValueOnce(ok(batch(0, 50)));
    await nm.fetchPage({ apiKey: "", topic: "top", skip: 0 });
    const keyed = await nm.fetchPage({ apiKey: "k", topic: "top", skip: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyed.articles).toHaveLength(20);
  });

  test("every article is cached by id, so /meta and /stream need no call", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 3)));
    await nm.fetchPage({ apiKey: "", topic: "top", skip: 0 });
    expect(articleCache.get("nm_evt_1").title).toBe(headline(1));
  });

  test("a topic it cannot serve is refused without a call", async () => {
    const fetchMock = jest.spyOn(global, "fetch");
    await expect(nm.fetchPage({ apiKey: "", topic: "domestic", skip: 0 })).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a story with no link to read is left out", async () => {
    const body = { events: [event(1), event(2, { sources: [] }), event(3, { sources: ["javascript:void(0)"] })] };
    jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(body));
    const page = await nm.fetchPage({ apiKey: "", topic: "top", skip: 0 });
    expect(page.articles.map((a) => a.id)).toEqual(["nm_evt_1"]);
  });

  test("near-duplicate events are shown once", async () => {
    const body = {
      events: [
        event(1, { headline: "Brighton Beats Arsenal 3-0" }),
        event(2, { headline: "Brighton Defeats Arsenal 3-0" }),
        event(3)
      ]
    };
    jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(body));
    const page = await nm.fetchPage({ apiKey: "", topic: "sports", skip: 0 });
    expect(page.articles.map((a) => a.id)).toEqual(["nm_evt_1", "nm_evt_3"]);
  });

  test("an answer with no events list is an empty page", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(ok({ total: 0 }));
    expect((await nm.fetchPage({ apiKey: "", topic: "top", skip: 0 })).articles).toEqual([]);
  });

  test("shopping posts are still filtered like any other source's", async () => {
    const body = { events: [event(1), event(2, { headline: "Save up to 57% on EcoFlow power stations" })] };
    jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(body));
    const page = await nm.fetchPage({ apiKey: "", topic: "top", skip: 0 });
    expect(page.articles.map((a) => a.id)).toEqual(["nm_evt_1"]);
  });
});

describe("fetchPage — searches and custom topics", () => {
  test("a search is relevance-ranked: no sort is sent", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 20)));
    await nm.fetchPage({ apiKey: "", query: "London", skip: 0 });
    expect(Object.fromEntries(urlOf(fetchMock.mock.calls[0]).searchParams)).toEqual({ q: "London", limit: "20" });
  });

  test("a narrow search is filled out from its relaxed form, exact matches first", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(ok({ events: [event(1), event(2)] }))
      .mockResolvedValueOnce(ok({ events: [event(2), event(3), event(4)] }));
    const page = await nm.fetchPage({ apiKey: "", query: "Indian Cricket", skip: 0 });

    expect(urlOf(fetchMock.mock.calls[0]).searchParams.get("q")).toBe("Indian Cricket");
    expect(urlOf(fetchMock.mock.calls[1]).searchParams.get("q")).toBe("Indian OR Cricket");
    expect(page.articles.map((a) => a.id)).toEqual(["nm_evt_1", "nm_evt_2", "nm_evt_3", "nm_evt_4"]);
  });

  test("the fill stops at the batch size", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(ok(batch(0, 5)))
      .mockResolvedValueOnce(ok(batch(100, 20)));
    const page = await nm.fetchPage({ apiKey: "", query: "Indian Cricket", skip: 0 });
    expect(page.articles).toHaveLength(20);
    expect(page.articles[0].id).toBe("nm_evt_0");
  });

  test("an empty relaxed answer leaves the exact matches as they were", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 2))).mockResolvedValueOnce(ok({}));
    expect((await nm.fetchPage({ apiKey: "", query: "Indian Cricket", skip: 0 })).articles).toHaveLength(2);
  });

  test("a search that fills the batch never costs a second call", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 20)));
    await nm.fetchPage({ apiKey: "", query: "Indian Cricket", skip: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a one-word search has nothing to relax, however few it finds", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 2)));
    await nm.fetchPage({ apiKey: "", query: "Mumbai", skip: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("'Top Stories (Not a lot of Trump)' is the top-stories feed without Trump", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(batch(0, 20)));
    await nm.fetchPage({ apiKey: "", query: "Top Stories (Not a lot of Trump)", skip: 0 });
    expect(Object.fromEntries(urlOf(fetchMock.mock.calls[0]).searchParams)).toEqual({
      sort: "trending",
      content_type: "news_report",
      q: "NOT Trump",
      limit: "20"
    });
  });

  test("the relaxed batch is cached with the strict one: a repeat costs nothing", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(ok(batch(0, 2)))
      .mockResolvedValueOnce(ok(batch(10, 5)));
    await nm.fetchPage({ apiKey: "", query: "Indian Cricket", skip: 0 });
    await nm.fetchPage({ apiKey: "", query: "Indian Cricket", skip: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("errors, as the failover chain needs to read them", () => {
  const fetchTop = (options) => nm.fetchPage({ apiKey: "", topic: "top", skip: 0 }, options);

  test("an unreachable API -- including a refused datacenter IP -- is a 502", async () => {
    jest.spyOn(global, "fetch").mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await expect(fetchTop()).rejects.toMatchObject({ status: 502, message: "Could not reach NewsMCP: connect ECONNREFUSED" });
  });

  test("a 200 that is not JSON is a 502, not an empty page", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(notJson(200));
    await expect(fetchTop()).rejects.toMatchObject({ status: 502, message: "NewsMCP returned HTTP 200" });
  });

  test("a validation error keeps the API's message and code", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(fail(400, { message: "Invalid sector value(s): x", error_code: "invalid_filter_value" }));
    await expect(fetchTop()).rejects.toMatchObject({ status: 400, message: "Invalid sector value(s): x", code: "invalid_filter_value" });
  });

  test("a scanner-UA refusal is a 403", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(fail(403, { message: "Automated scanner", error_code: "malicious_bot_ua" }));
    await expect(fetchTop()).rejects.toMatchObject({ status: 403, code: "malicious_bot_ua" });
  });

  test("an error page that is not JSON still reports its status", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(notJson(503));
    await expect(fetchTop()).rejects.toMatchObject({ status: 503, message: "NewsMCP returned HTTP 503" });
  });

  test("a spent budget quotes its wait, which the error carries; no retry", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(fail(429, { message: "Hourly limit reached", retry_after_seconds: 600 }));
    await expect(fetchTop(noWait)).rejects.toMatchObject({ status: 429, retryAfterMs: 600000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("the wait may come as retry_after, or in the Retry-After header", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(fail(429, { retry_after: 30 }));
    await expect(fetchTop(noWait)).rejects.toMatchObject({ retryAfterMs: 30000 });
    jest.spyOn(global, "fetch").mockResolvedValueOnce(fail(429, { retry_after: 0 }, { "retry-after": "45" }));
    await expect(fetchTop(noWait)).rejects.toMatchObject({ retryAfterMs: 45000 });
    jest.spyOn(global, "fetch").mockResolvedValueOnce(fail(429, null, { "retry-after": "12" }));
    await expect(fetchTop(noWait)).rejects.toMatchObject({ retryAfterMs: 12000 });
  });

  test("a 429 quoting no wait is a collision: retried once, after a pause", async () => {
    const wait = jest.fn(async () => {});
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(fail(429, { message: "Too many concurrent requests" }))
      .mockResolvedValueOnce(ok(batch(0, 20)));
    const page = await fetchTop({ wait });
    expect(page.articles).toHaveLength(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(nm.COLLISION_RETRY_MS);
  });

  test("a second collision is given up on, as a plain 429", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(fail(429, { message: "busy" }));
    const err = await fetchTop(noWait).catch((e) => e);
    expect(err).toMatchObject({ status: 429, message: "busy" });
    expect(err.retryAfterMs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("the retry waits for real when nothing is injected", async () => {
    jest.useFakeTimers();
    try {
      jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(fail(429, {}))
        .mockResolvedValueOnce(ok(batch(0, 1)));
      const pending = fetchTop();
      await jest.advanceTimersByTimeAsync(nm.COLLISION_RETRY_MS);
      expect((await pending).articles).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a failure is not cached: the next request asks again", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(notJson(503)).mockResolvedValueOnce(ok(batch(0, 3)));
    await expect(fetchTop()).rejects.toMatchObject({ status: 503 });
    expect((await fetchTop()).articles).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("one request in flight per caller", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };
  const flush = () => new Promise((r) => setImmediate(r));

  test("a second catalog waits for the first rather than colliding", async () => {
    const first = deferred();
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(ok(batch(100, 2)));

    const a = nm.fetchPage({ apiKey: "", topic: "sports", skip: 0 });
    const b = nm.fetchPage({ apiKey: "", topic: "health", skip: 0 });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.resolve(ok(batch(0, 2)));
    await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("different keys do not wait for each other", async () => {
    const first = deferred();
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(ok(batch(100, 2)));

    const a = nm.fetchPage({ apiKey: "key-a", topic: "sports", skip: 0 });
    const b = nm.fetchPage({ apiKey: "key-b", topic: "sports", skip: 0 });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    first.resolve(ok(batch(0, 2)));
    await Promise.all([a, b]);
  });

  test("a failed request does not jam the queue behind it", async () => {
    jest
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(ok(batch(0, 2)));
    const a = nm.fetchPage({ apiKey: "", topic: "sports", skip: 0 });
    const b = nm.fetchPage({ apiKey: "", topic: "health", skip: 0 });
    await expect(a).rejects.toMatchObject({ status: 502 });
    expect((await b).articles).toHaveLength(2);
  });
});

describe("getArticleById — when the cache cannot answer", () => {
  test("looks the event up and keeps the id it was asked for", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(event(7)));
    const article = await nm.getArticleById("k", "evt_7");
    expect(urlOf(fetchMock.mock.calls[0]).pathname).toBe("/v0/news/evt_7");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("k");
    expect(article.id).toBe("nm_evt_7");
    expect(articleCache.get("nm_evt_7")).toEqual(article);
  });

  test("the id is escaped into the path", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(event(1)));
    await nm.getArticleById("", "evt_1/../limits");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.newsmcp.com/v0/news/evt_1%2F..%2Flimits");
  });

  test("a story that is simply gone is null, not an error", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(fail(404, { message: "No readable event with id 'evt_dead'", error_code: "event_not_found" }));
    await expect(nm.getArticleById("", "evt_dead")).resolves.toBeNull();
  });

  test("a 404 that names no id at all is null", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(fail(404, { message: "Not found" }));
    await expect(nm.getArticleById("", "evt_1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a story folded into a bigger one is followed to its new id, once", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(fail(404, { message: "Event evt_old was merged into evt_new" }))
      .mockResolvedValueOnce(ok(event(9, { event_id: "evt_new" })));
    const article = await nm.getArticleById("", "evt_old");
    expect(urlOf(fetchMock.mock.calls[1]).pathname).toBe("/v0/news/evt_new");
    // Stremio holds the old id, so that is the one the article answers to.
    expect(article.id).toBe("nm_evt_old");
    expect(articleCache.get("nm_evt_old")).toBe(article);
  });

  test("if the new id is gone too, the story is null", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(fail(404, { message: "merged into evt_new" }))
      .mockResolvedValueOnce(fail(404, { message: "No readable event with id 'evt_new'" }));
    await expect(nm.getArticleById("", "evt_old")).resolves.toBeNull();
  });

  test("any other failure is thrown, for the caller to bench the source", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(fail(429, { retry_after_seconds: 60 }));
    await expect(nm.getArticleById("", "evt_1")).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });

    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(fail(404, { message: "merged into evt_new" }))
      .mockResolvedValueOnce(notJson(503));
    await expect(nm.getArticleById("", "evt_old")).rejects.toMatchObject({ status: 503 });
  });

  test("an event with nothing to read is null", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(ok(event(1, { sources: [] })));
    await expect(nm.getArticleById("", "evt_1")).resolves.toBeNull();
  });
});
