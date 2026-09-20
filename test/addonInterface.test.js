const { clearAllCaches } = require("../src/cache");
const { createAddonInterface } = require("../src/addonInterface");
const { PAGE_SIZE } = require("../src/newsdata");

let iface;
beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  iface = createAddonInterface();
});

const ok = (data) => ({ ok: true, json: async () => data });
const article = (id, extra = {}) => ({
  article_id: id,
  title: `Title ${id}`,
  link: `https://example.com/${id}`,
  ...extra
});
const CONFIG = { apiKey: "k", topics: ["technology"], language: "en" };

describe("catalog handler", () => {
  test("returns metas for a valid topic and config", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    const res = await iface.get("catalog", "news", "technology", {}, CONFIG);
    expect(res.metas).toHaveLength(1);
    expect(res.metas[0].id).toBe("nd_a1");
  });

  test("sets a cache hint so clients do not refetch on every scroll", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [], nextPage: null }));
    expect((await iface.get("catalog", "news", "technology", {}, CONFIG)).cacheMaxAge).toBe(600);
  });

  test("maps the topic id to the right upstream category", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [], nextPage: null }));
    await iface.get("catalog", "news", "business", {}, CONFIG);
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("category")).toBe("business");
  });

  test("uses the configured language", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [], nextPage: null }));
    await iface.get("catalog", "news", "technology", {}, { apiKey: "k", language: "ja" });
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("language")).toBe("ja");
  });

  test("returns empty metas for an unknown topic id", async () => {
    expect((await iface.get("catalog", "news", "not-a-topic", {}, CONFIG)).metas).toEqual([]);
  });

  test("returns empty metas when the config has no api key", async () => {
    expect((await iface.get("catalog", "news", "technology", {}, {})).metas).toEqual([]);
    expect((await iface.get("catalog", "news", "technology", {}, null)).metas).toEqual([]);
  });

  test("degrades to an empty shelf instead of throwing when upstream fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("rate limited"));
    expect((await iface.get("catalog", "news", "technology", {}, CONFIG)).metas).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  test("search sends a free-text query and drops the category filter", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("s1")], nextPage: null }));
    const res = await iface.get("catalog", "news", "technology", { search: "ai chips" }, CONFIG);
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("ai chips");
    expect(url.searchParams.has("category")).toBe(false);
    expect(res.metas[0].id).toBe("nd_s1");
  });

  test("skip advances to the next page of results", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(ok({ results: [article("a1")], nextPage: "T1" }))
      .mockResolvedValueOnce(ok({ results: [article("a2")], nextPage: null }));
    await iface.get("catalog", "news", "technology", {}, CONFIG);
    const page2 = await iface.get("catalog", "news", "technology", { skip: String(PAGE_SIZE) }, CONFIG);
    expect(page2.metas[0].id).toBe("nd_a2");
  });

  test("a non-numeric skip is treated as the first page", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    const res = await iface.get("catalog", "news", "technology", { skip: "abc" }, CONFIG);
    expect(res.metas[0].id).toBe("nd_a1");
  });

  test("handles a missing extra object", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    expect((await iface.get("catalog", "news", "technology", undefined, CONFIG)).metas).toHaveLength(1);
  });

  test("search and skip combine for paginated search results", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(ok({ results: [article("s1")], nextPage: "T1" }))
      .mockResolvedValueOnce(ok({ results: [article("s2")], nextPage: null }));
    await iface.get("catalog", "news", "technology", { search: "chips" }, CONFIG);
    const p2 = await iface.get("catalog", "news", "technology", { search: "chips", skip: String(PAGE_SIZE) }, CONFIG);
    expect(p2.metas[0].id).toBe("nd_s2");
    expect(new URL(global.fetch.mock.calls[1][0]).searchParams.get("q")).toBe("chips");
  });
});

describe("meta handler", () => {
  test("returns full metadata for a known article id", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      ok({ results: [article("a1", { category: ["technology"], image_url: "https://e.com/i.jpg" })] })
    );
    const res = await iface.get("meta", "news", "nd_a1", {}, CONFIG);
    expect(res.meta.id).toBe("nd_a1");
    expect(res.meta.type).toBe("news");
    expect(res.meta.name).toBe("Title a1");
    expect(res.meta.poster).toBe("https://e.com/i.jpg");
    expect(res.meta.genres).toEqual(["technology"]);
    expect(res.cacheMaxAge).toBe(3600);
  });

  test("resolves an id first seen in a catalog request", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    await iface.get("catalog", "news", "technology", {}, CONFIG);
    global.fetch.mockClear();
    expect((await iface.get("meta", "news", "nd_a1", {}, CONFIG)).meta.id).toBe("nd_a1");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("rejects when the article cannot be found", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [] }));
    await expect(iface.get("meta", "news", "nd_missing", {}, CONFIG)).rejects.toThrow(/not found/i);
  });
});

describe("stream handler", () => {
  test("returns a playable video stream when the story has a video URL", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      ok({ results: [article("a1", { video_url: "https://e.com/a1.mp4" })] })
    );
    const res = await iface.get("stream", "news", "nd_a1", {}, CONFIG);
    expect(res.streams[0].externalUrl).toBe("https://e.com/a1.mp4");
    expect(res.streams).toHaveLength(2);
    expect(res.cacheMaxAge).toBe(3600);
  });

  test("returns only the article link when the story has no video", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a2")] }));
    const res = await iface.get("stream", "news", "nd_a2", {}, CONFIG);
    expect(res.streams).toHaveLength(1);
    expect(res.streams[0].externalUrl).toBe("https://example.com/a2");
  });

  test("returns an empty list rather than erroring for an unknown id", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [] }));
    expect((await iface.get("stream", "news", "nd_missing", {}, CONFIG)).streams).toEqual([]);
  });
});

describe("interface wiring", () => {
  test("defines all three handlers declared in the manifest", () => {
    expect(iface.manifest.resources).toEqual(expect.arrayContaining(["catalog", "meta", "stream"]));
  });

  test("rejects an unknown resource with the SDK's noHandler marker", async () => {
    await expect(iface.get("subtitles", "news", "nd_a1", {}, CONFIG)).rejects.toMatchObject({ noHandler: true });
  });
});
