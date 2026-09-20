const { TOPICS } = require("../src/topics");

const BASE_URL = "https://newsio.up.railway.app";

// manifest.js reads process.env at call time, so each test can vary it.
let M;
beforeEach(() => {
  jest.resetModules();
  delete process.env.STREMIO_ADDONS_CONFIG_SIGNATURE;
  delete process.env.STREMIO_ADDONS_CONFIG_ISSUER;
  M = require("../src/manifest");
});

describe("manifest basics", () => {
  test("version is the initial release 0.1.0", () => {
    expect(M.ADDON_VERSION).toBe("0.1.0");
  });

  test("uses the custom news content type, not movie/series/channel", () => {
    expect(M.CONTENT_TYPE).toBe("news");
    expect(M.getUnconfiguredManifest(BASE_URL).types).toEqual(["news"]);
  });

  test("declares the nd_ id prefix so Stremio only routes our ids to us", () => {
    expect(M.getUnconfiguredManifest(BASE_URL).idPrefixes).toEqual(["nd_"]);
  });

  test("declares catalog, meta and stream resources", () => {
    expect(M.getUnconfiguredManifest(BASE_URL).resources).toEqual(["catalog", "meta", "stream"]);
  });

  test("carries the fields a public listing needs", () => {
    const m = M.getUnconfiguredManifest(BASE_URL);
    expect(typeof m.id).toBe("string");
    expect(m.name).toBe("Newsio");
    expect(m.description.length).toBeGreaterThan(20);
    expect(m.contactEmail).toMatch(/@/);
    expect(m.logo).toBe(`${BASE_URL}/logo.png`);
    expect(m.background).toBe(`${BASE_URL}/background.png`);
  });

  test("asset URLs follow the host it is served from", () => {
    expect(M.getUnconfiguredManifest("https://other.example").logo).toBe("https://other.example/logo.png");
  });

  test("stays within the 8KB addonCollection limit", () => {
    const full = M.buildManifest({ topics: TOPICS.map((t) => t.id) }, BASE_URL);
    expect(JSON.stringify(full).length).toBeLessThan(8192);
  });
});

describe("unconfigured manifest", () => {
  test("has no catalogs and requires configuration", () => {
    const m = M.getUnconfiguredManifest(BASE_URL);
    expect(m.catalogs).toEqual([]);
    expect(m.behaviorHints).toEqual({ configurable: true, configurationRequired: true });
  });
});

describe("configured manifest", () => {
  test("turns each selected topic into its own catalog named after the topic", () => {
    const m = M.buildManifest({ apiKey: "x", topics: ["technology", "business"] }, BASE_URL);
    expect(m.catalogs).toHaveLength(2);
    expect(m.catalogs.map((c) => c.name)).toEqual(["Technology", "Finance & Business"]);
    expect(m.catalogs.map((c) => c.id)).toEqual(["technology", "business"]);
  });

  test("preserves the order the user's topics were given in", () => {
    const m = M.buildManifest({ topics: ["sports", "top", "health"] }, BASE_URL);
    expect(m.catalogs.map((c) => c.id)).toEqual(["sports", "top", "health"]);
  });

  test("every catalog advertises search and skip support", () => {
    const m = M.buildManifest({ topics: ["technology"] }, BASE_URL);
    expect(m.catalogs[0].type).toBe("news");
    expect(m.catalogs[0].extra).toEqual([{ name: "search" }, { name: "skip" }]);
  });

  test("with topics selected it no longer requires configuration", () => {
    expect(M.buildManifest({ topics: ["top"] }, BASE_URL).behaviorHints).toEqual({
      configurable: true,
      configurationRequired: false
    });
  });

  test("with zero topics it still requires configuration", () => {
    expect(M.buildManifest({ topics: [] }, BASE_URL).behaviorHints.configurationRequired).toBe(true);
  });

  test("silently drops unknown topic ids", () => {
    expect(M.buildManifest({ topics: ["nope", "technology"] }, BASE_URL).catalogs.map((c) => c.id)).toEqual([
      "technology"
    ]);
  });

  test("tolerates a missing/empty config object", () => {
    expect(M.buildManifest({}, BASE_URL).catalogs).toEqual([]);
    expect(M.buildManifest(null, BASE_URL).catalogs).toEqual([]);
  });

  test("stays configurable so Stremio keeps showing the Configure button", () => {
    expect(M.buildManifest({ topics: ["top"] }, BASE_URL).behaviorHints.configurable).toBe(true);
  });

  test("exposes no native config array (our own HTML page is used instead)", () => {
    expect(M.buildManifest({ topics: ["top"] }, BASE_URL).config).toBeUndefined();
    expect(M.getUnconfiguredManifest(BASE_URL).config).toBeUndefined();
  });

  test("keeps a constant addon id across variants so reconfiguring is the same addon", () => {
    expect(M.buildManifest({ topics: ["top"] }, BASE_URL).id).toBe(M.ADDON_ID);
    expect(M.getUnconfiguredManifest(BASE_URL).id).toBe(M.ADDON_ID);
    expect(M.buildInterfaceManifest().id).toBe(M.ADDON_ID);
  });
});

describe("stremio-addons.net listing credential", () => {
  test("is omitted when no signature is configured", () => {
    expect(M.getUnconfiguredManifest(BASE_URL).stremioAddonsConfig).toBeUndefined();
    expect(M.getStremioAddonsConfig()).toBeUndefined();
  });

  test("is included, with the default issuer, when a signature is set", () => {
    process.env.STREMIO_ADDONS_CONFIG_SIGNATURE = "sig-abc";
    jest.resetModules();
    const M2 = require("../src/manifest");
    expect(M2.getUnconfiguredManifest(BASE_URL).stremioAddonsConfig).toEqual({
      issuer: "https://stremio-addons.net",
      signature: "sig-abc"
    });
  });

  test("appears on the configured manifest too", () => {
    process.env.STREMIO_ADDONS_CONFIG_SIGNATURE = "sig-xyz";
    jest.resetModules();
    const M2 = require("../src/manifest");
    expect(M2.buildManifest({ topics: ["top"] }, BASE_URL).stremioAddonsConfig.signature).toBe("sig-xyz");
  });

  test("honours a custom issuer override", () => {
    process.env.STREMIO_ADDONS_CONFIG_SIGNATURE = "s";
    process.env.STREMIO_ADDONS_CONFIG_ISSUER = "https://example.test";
    jest.resetModules();
    const M2 = require("../src/manifest");
    expect(M2.getStremioAddonsConfig().issuer).toBe("https://example.test");
  });
});

describe("internal interface manifest", () => {
  test("declares every topic so any topic id routes to the catalog handler", () => {
    const im = M.buildInterfaceManifest();
    expect(im.catalogs).toHaveLength(TOPICS.length);
    expect(im.catalogs.map((c) => c.id).sort()).toEqual(TOPICS.map((t) => t.id).sort());
  });

  test("has a non-empty config array, which is what enables the SDK's :config route prefix", () => {
    expect(M.buildInterfaceManifest().config.length).toBeGreaterThan(0);
  });

  test("passes the official SDK manifest linter", () => {
    const { addonBuilder } = require("stremio-addon-sdk");
    expect(() => new addonBuilder(M.buildInterfaceManifest())).not.toThrow();
  });
});
