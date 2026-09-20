const request = require("supertest");
const { clearAllCaches } = require("../src/cache");
const { encodeConfig } = require("../src/config");
const { PAGE_SIZE } = require("../src/newsdata");

let app;
beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  ({ app } = require("../server"));
});

const ok = (data) => ({ ok: true, json: async () => data });
const article = (id, extra = {}) => ({
  article_id: id,
  title: `Title ${id}`,
  link: `https://example.com/${id}`,
  ...extra
});
const CFG = () => encodeConfig({ apiKey: "TEST_KEY", topics: ["technology", "business"], language: "en" });

describe("basic routes", () => {
  test("GET / redirects to the configure page", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/configure");
  });

  test("GET /configure serves the HTML configuration page", async () => {
    const res = await request(app).get("/configure");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("Newsio");
    expect(res.text).toContain("newsdata.io API key");
  });

  test("GET /health returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test("serves the logo and background assets referenced by the manifest", async () => {
    const png = await request(app).get("/logo.png");
    const bg = await request(app).get("/background.png");
    expect(png.status).toBe(200);
    expect(png.headers["content-type"]).toMatch(/image\/png/);
    expect(bg.status).toBe(200);
  });

  test("serves the SVG assets too", async () => {
    expect((await request(app).get("/logo.svg")).status).toBe(200);
    expect((await request(app).get("/background.svg")).status).toBe(200);
  });
});

describe("manifest routes", () => {
  test("the bare manifest requires configuration and lists no catalogs", async () => {
    const res = await request(app).get("/manifest.json");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("org.deejay189393.newsio");
    expect(res.body.version).toBe("0.1.0");
    expect(res.body.catalogs).toEqual([]);
    expect(res.body.behaviorHints.configurationRequired).toBe(true);
    expect(res.body.types).toEqual(["news"]);
  });

  test("a configured manifest lists the chosen topics as catalog names", async () => {
    const res = await request(app).get(`/${CFG()}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.body.catalogs.map((c) => c.name)).toEqual(["Technology", "Finance & Business"]);
    expect(res.body.behaviorHints.configurationRequired).toBe(false);
    expect(res.body.behaviorHints.configurable).toBe(true);
  });

  test("advertises https asset URLs when behind a TLS-terminating proxy", async () => {
    const res = await request(app).get("/manifest.json").set("x-forwarded-proto", "https");
    expect(res.body.logo.startsWith("https://")).toBe(true);
    expect(res.body.background.startsWith("https://")).toBe(true);
  });

  test("handles a comma-joined x-forwarded-proto chain", async () => {
    const res = await request(app).get("/manifest.json").set("x-forwarded-proto", "https, http");
    expect(res.body.logo.startsWith("https://")).toBe(true);
  });

  test("an invalid config segment returns 400 rather than a wrong manifest", async () => {
    const res = await request(app).get("/garbage-not-json/manifest.json");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/configuration/i);
  });
});

describe("configure / re-configure routes", () => {
  test("/:config/configure pre-fills the existing settings", async () => {
    const res = await request(app).get(`/${CFG()}/configure`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("TEST_KEY");
    expect(res.text).toContain('value="technology" checked');
    expect(res.text).toContain("Editing your current setup");
  });

  test("an invalid config segment on configure returns 400", async () => {
    expect((await request(app).get("/garbage-not-json/configure")).status).toBe(400);
  });

  test("the generated install URL round-trips back into a valid manifest", async () => {
    // Reproduce exactly what the page's client-side code builds.
    const segment = encodeURIComponent(JSON.stringify({ apiKey: "K", topics: ["sports"], language: "de" }));
    const res = await request(app).get(`/${segment}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.body.catalogs.map((c) => c.name)).toEqual(["Sports"]);
  });
});

describe("catalog route", () => {
  test("returns metas for a configured topic", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a1")], nextPage: null }));
    const res = await request(app).get(`/${CFG()}/catalog/news/technology.json`);
    expect(res.status).toBe(200);
    expect(res.body.metas).toHaveLength(1);
    expect(res.body.metas[0]).toMatchObject({ id: "nd_a1", type: "news", name: "Title a1" });
  });

  test("supports search from Stremio's search bar", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("s1")], nextPage: null }));
    const res = await request(app).get(`/${CFG()}/catalog/news/technology/search=ai%20chips.json`);
    expect(res.status).toBe(200);
    expect(res.body.metas[0].id).toBe("nd_s1");
    expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get("q")).toBe("ai chips");
  });

  test("supports skip-based pagination", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(ok({ results: [article("a1")], nextPage: "T1" }))
      .mockResolvedValueOnce(ok({ results: [article("a2")], nextPage: null }));
    const cfg = CFG();
    await request(app).get(`/${cfg}/catalog/news/technology.json`);
    const res = await request(app).get(`/${cfg}/catalog/news/technology/skip=${PAGE_SIZE}.json`);
    expect(res.body.metas[0].id).toBe("nd_a2");
  });

  test("supports search and skip combined in one extra segment", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(ok({ results: [article("s1")], nextPage: "T1" }))
      .mockResolvedValueOnce(ok({ results: [article("s2")], nextPage: null }));
    const cfg = CFG();
    await request(app).get(`/${cfg}/catalog/news/technology/search=chips.json`);
    const res = await request(app).get(`/${cfg}/catalog/news/technology/search=chips&skip=${PAGE_SIZE}.json`);
    expect(res.body.metas[0].id).toBe("nd_s2");
  });

  test("sets a Cache-Control header from the handler's cache hint", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [], nextPage: null }));
    const res = await request(app).get(`/${CFG()}/catalog/news/technology.json`);
    expect(res.headers["cache-control"]).toMatch(/max-age=600/);
  });

  test("degrades to an empty shelf when the API key is rejected upstream", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ results: { message: "Invalid API key" } })
    });
    const res = await request(app).get(`/${CFG()}/catalog/news/technology.json`);
    expect(res.status).toBe(200);
    expect(res.body.metas).toEqual([]);
  });

  test("returns empty metas when the stored config has no API key", async () => {
    const cfg = encodeConfig({ apiKey: "", topics: ["technology"], language: "en" });
    const res = await request(app).get(`/${cfg}/catalog/news/technology.json`);
    expect(res.status).toBe(200);
    expect(res.body.metas).toEqual([]);
  });
});

describe("meta route", () => {
  test("returns metadata for an article seen in a catalog", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      ok({ results: [article("a1", { image_url: "https://e.com/i.jpg", pubDate: "2026-09-18 10:00:00" })], nextPage: null })
    );
    const cfg = CFG();
    await request(app).get(`/${cfg}/catalog/news/technology.json`);
    const res = await request(app).get(`/${cfg}/meta/news/nd_a1.json`);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({
      id: "nd_a1",
      type: "news",
      name: "Title a1",
      poster: "https://e.com/i.jpg",
      releaseInfo: "2026-09-18"
    });
  });

  test("resolves an article never seen before via a direct id lookup", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("cold", { title: "Cold start" })] }));
    const res = await request(app).get(`/${CFG()}/meta/news/nd_cold.json`);
    expect(res.status).toBe(200);
    expect(res.body.meta.name).toBe("Cold start");
  });

  test("tags a video article's description with [VIDEO]", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      ok({ results: [article("v1", { description: "Watch this.", video_url: "https://e.com/v.mp4" })] })
    );
    const res = await request(app).get(`/${CFG()}/meta/news/nd_v1.json`);
    expect(res.body.meta.description).toBe("[VIDEO] Watch this.");
  });

  test("returns a 500-class error for an article that cannot be resolved", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [] }));
    const res = await request(app).get(`/${CFG()}/meta/news/nd_nope.json`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("stream route", () => {
  test("returns a play-video stream plus the article link for a video story", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      ok({ results: [article("a1", { video_url: "https://e.com/a1.mp4" })], nextPage: null })
    );
    const cfg = CFG();
    await request(app).get(`/${cfg}/catalog/news/technology.json`);
    const res = await request(app).get(`/${cfg}/stream/news/nd_a1.json`);
    expect(res.status).toBe(200);
    expect(res.body.streams).toHaveLength(2);
    expect(res.body.streams[0].externalUrl).toBe("https://e.com/a1.mp4");
  });

  test("returns a single read-article stream for a text story", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [article("a2")], nextPage: null }));
    const cfg = CFG();
    await request(app).get(`/${cfg}/catalog/news/technology.json`);
    const res = await request(app).get(`/${cfg}/stream/news/nd_a2.json`);
    expect(res.body.streams).toHaveLength(1);
    expect(res.body.streams[0].externalUrl).toBe("https://example.com/a2");
  });

  test("returns an empty stream list for an unresolvable id", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [] }));
    const res = await request(app).get(`/${CFG()}/stream/news/nd_nope.json`);
    expect(res.status).toBe(200);
    expect(res.body.streams).toEqual([]);
  });
});

describe("addon protocol conformance", () => {
  test("resource responses carry permissive CORS headers", async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ results: [], nextPage: null }));
    const res = await request(app).get(`/${CFG()}/catalog/news/technology.json`);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  test("responses are served as JSON", async () => {
    const res = await request(app).get("/manifest.json");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  test("an unknown resource path 404s", async () => {
    const res = await request(app).get(`/${CFG()}/nonsense/news/x.json`);
    expect(res.status).toBe(404);
  });
});

describe("end-to-end user journey", () => {
  test("configure -> install -> browse -> open -> play", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      ok({
        results: [article("j1", { video_url: "https://e.com/j1.mp4", image_url: "https://e.com/j1.jpg" })],
        nextPage: null
      })
    );

    // 1. user opens the configure page
    expect((await request(app).get("/configure")).status).toBe(200);

    // 2. the page builds this install URL from their choices
    const cfg = encodeConfig({ apiKey: "K", topics: ["technology"], language: "en" });
    const manifest = await request(app).get(`/${cfg}/manifest.json`);
    expect(manifest.body.catalogs[0].name).toBe("Technology");

    // 3. Stremio loads the catalog for that topic
    const catalog = await request(app).get(`/${cfg}/catalog/news/technology.json`);
    const item = catalog.body.metas[0];
    expect(item.id).toBe("nd_j1");

    // 4. user opens the item -> metadata resolves by that id
    const meta = await request(app).get(`/${cfg}/meta/news/${item.id}.json`);
    expect(meta.body.meta.name).toBe("Title j1");

    // 5. user hits play -> a video stream exists for that id
    const stream = await request(app).get(`/${cfg}/stream/news/${item.id}.json`);
    expect(stream.body.streams[0].externalUrl).toBe("https://e.com/j1.mp4");
  });
});
