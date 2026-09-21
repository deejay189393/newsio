const { TOPICS } = require("../src/providers");

const BASE_URL = "https://newsio.up.railway.app";
const KEY = "pub_testkey";
const { isConfigured } = require("../src/config");

// manifest.js reads process.env at call time, so each test can vary it.
let M;
beforeEach(() => {
  jest.resetModules();
  delete process.env.STREMIO_ADDONS_CONFIG_SIGNATURE;
  delete process.env.STREMIO_ADDONS_CONFIG_ISSUER;
  M = require("../src/manifest");
});

describe("manifest basics", () => {
  test("version is 0.9.1", () => {
    expect(M.ADDON_VERSION).toBe("0.9.1");
  });

  test("uses the short addon description", () => {
    expect(M.DESCRIPTION).toBe("News on Stremio? Why not! Reads live headlines from newsdata.io, Currents, YouTube and GNews.");
    expect(M.getUnconfiguredManifest(BASE_URL).description).toBe(M.DESCRIPTION);
  });

  test("uses the custom news content type, not movie/series/channel", () => {
    expect(M.CONTENT_TYPE).toBe("news");
    expect(M.getUnconfiguredManifest(BASE_URL).types).toEqual(["news"]);
  });

  test("declares one id prefix per provider, so every id we mint routes to us", () => {
    const { PROVIDERS } = require("../src/providers");
    expect(M.getUnconfiguredManifest(BASE_URL).idPrefixes).toEqual(PROVIDERS.map((p) => p.idPrefix));
    expect(M.getUnconfiguredManifest(BASE_URL).idPrefixes).toEqual(["yt_", "cu_", "nd_", "gn_"]);
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
    expect(m.logo).toBe(`${BASE_URL}/logo.png?v=${M.ADDON_VERSION}`);
    expect(m.background).toBe(`${BASE_URL}/background.png?v=${M.ADDON_VERSION}`);
  });

  test("asset URLs follow the host it is served from", () => {
    expect(M.getUnconfiguredManifest("https://other.example").logo).toBe(
      `https://other.example/logo.png?v=${M.ADDON_VERSION}`
    );
  });

  test("stays within the 8KB addonCollection limit", () => {
    const full = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: TOPICS.map((t) => t.id) }, BASE_URL);
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
  const topicCatalogs = (m) => m.catalogs.filter((c) => c.id !== M.SEARCH_CATALOG_ID);
  const searchCatalogOf = (m) => m.catalogs.find((c) => c.id === M.SEARCH_CATALOG_ID);

  test("turns each selected topic into its own catalog named after the topic", () => {
    const m = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: "x" }], topics: ["technology", "business"] }, BASE_URL);
    expect(topicCatalogs(m).map((c) => c.name)).toEqual(["Technology", "Finance & Business"]);
    expect(topicCatalogs(m).map((c) => c.id)).toEqual(["technology", "business"]);
  });

  test("preserves the order the user's topics were given in", () => {
    const m = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["sports", "top", "health"] }, BASE_URL);
    expect(topicCatalogs(m).map((c) => c.id)).toEqual(["sports", "top", "health"]);
  });

  test("topic catalogs are browse-only: skip, but no search", () => {
    const m = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["technology"] }, BASE_URL);
    topicCatalogs(m).forEach((c) => {
      expect(c.type).toBe("news");
      expect(c.extra).toEqual([{ name: "skip", options: M.SKIP_OPTIONS }]);
      expect(c.extra.some((e) => e.name === "search")).toBe(false);
    });
  });

  // Regression: search used to be declared on every topic catalog, so a
  // single query produced one identical result row per selected topic --
  // "Top Stories - News", "Technology - News", "Science - News", ... all
  // showing the same articles.
  test("exactly one catalog in the whole manifest handles search", () => {
    const m = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top", "technology", "science", "health"] }, BASE_URL);
    const searchable = m.catalogs.filter((c) => c.extra.some((e) => e.name === "search"));
    expect(searchable).toHaveLength(1);
    expect(searchable[0].id).toBe(M.SEARCH_CATALOG_ID);
  });

  test("the search catalog is named for the addon, so the row reads \"Newsio\"", () => {
    const m = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL);
    expect(searchCatalogOf(m).name).toBe("Newsio");
    expect(M.SEARCH_CATALOG_NAME).toBe("Newsio");
  });

  test("the search catalog marks search required so it is not a browsable shelf", () => {
    const m = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL);
    expect(searchCatalogOf(m).extra).toEqual([
      { name: "search", isRequired: true },
      { name: "skip", options: M.SKIP_OPTIONS }
    ]);
  });

  test("the search catalog is appended once, after the topics", () => {
    const m = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top", "world"] }, BASE_URL);
    expect(m.catalogs.map((c) => c.id)).toEqual(["top", "world", "search"]);
  });

  test("the search catalog id cannot collide with a topic id", () => {
    expect(TOPICS.map((t) => t.id)).not.toContain(M.SEARCH_CATALOG_ID);
  });

  test("selecting every topic still yields exactly one search catalog", () => {
    const m = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: TOPICS.map((t) => t.id) }, BASE_URL);
    expect(m.catalogs).toHaveLength(TOPICS.length + 1);
    expect(m.catalogs.filter((c) => c.id === M.SEARCH_CATALOG_ID)).toHaveLength(1);
  });

  test("with topics selected it no longer requires configuration", () => {
    expect(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL).behaviorHints).toEqual({
      configurable: true,
      configurationRequired: false
    });
  });

  test("with zero topics it still requires configuration", () => {
    expect(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: [] }, BASE_URL).behaviorHints.configurationRequired).toBe(true);
  });

  test("silently drops unknown topic ids", () => {
    expect(topicCatalogs(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["nope", "technology"] }, BASE_URL)).map((c) => c.id)).toEqual([
      "technology"
    ]);
  });

  test("no catalogs at all -- not even search -- when nothing is configured", () => {
    expect(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: [] }, BASE_URL).catalogs).toEqual([]);
    expect(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["nope"] }, BASE_URL).catalogs).toEqual([]);
  });

  test("tolerates a missing/empty config object", () => {
    expect(M.buildManifest({}, BASE_URL).catalogs).toEqual([]);
    expect(M.buildManifest(null, BASE_URL).catalogs).toEqual([]);
  });

  test("stays configurable so Stremio keeps showing the Configure button", () => {
    expect(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL).behaviorHints.configurable).toBe(true);
  });

  test("exposes no native config array (our own HTML page is used instead)", () => {
    expect(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL).config).toBeUndefined();
    expect(M.getUnconfiguredManifest(BASE_URL).config).toBeUndefined();
  });

  test("keeps a constant addon id across variants so reconfiguring is the same addon", () => {
    expect(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL).id).toBe(M.ADDON_ID);
    expect(M.getUnconfiguredManifest(BASE_URL).id).toBe(M.ADDON_ID);
    expect(M.buildInterfaceManifest().id).toBe(M.ADDON_ID);
  });
});

describe("pagination is declared to the client", () => {
  const { CATALOG_PAGE_SIZE } = require("../src/articles");

  // Without declared options the protocol says the client assumes a page
  // size of 100 AND treats a shorter page as the end of the catalog -- so a
  // 20-item page would never paginate at all.
  test("skip options step by exactly one catalog page", () => {
    expect(M.SKIP_OPTIONS[0]).toBe("0");
    M.SKIP_OPTIONS.forEach((opt, i) => expect(opt).toBe(String(i * CATALOG_PAGE_SIZE)));
  });

  test("the steps are strings, as the protocol requires", () => {
    M.SKIP_OPTIONS.forEach((o) => expect(typeof o).toBe("string"));
  });

  test("enough pages are offered to be a useful feed", () => {
    expect(M.SKIP_OPTIONS).toHaveLength(M.CATALOG_PAGE_COUNT);
    expect(M.CATALOG_PAGE_COUNT * CATALOG_PAGE_SIZE).toBeGreaterThanOrEqual(200);
  });

  test("every catalog -- topic and search alike -- declares the same steps", () => {
    const m = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top", "world"] }, BASE_URL);
    m.catalogs.forEach((c) => {
      const skip = c.extra.find((e) => e.name === "skip");
      expect(skip).toBeDefined();
      expect(skip.options).toEqual(M.SKIP_OPTIONS);
    });
  });

  test("the internal routing manifest declares them too", () => {
    M.buildInterfaceManifest().catalogs.forEach((c) => {
      expect(c.extra.find((e) => e.name === "skip").options).toEqual(M.SKIP_OPTIONS);
    });
  });
});

describe("configuration is mandatory", () => {
  // The addon protocol expresses this as behaviorHints.configurationRequired:
  // when true, Stremio hides "Install" and shows "Configure" instead.
  const required = (cfg) => M.buildManifest(cfg, BASE_URL).behaviorHints.configurationRequired;
  const catalogsFor = (cfg) => M.buildManifest(cfg, BASE_URL).catalogs;

  test("the bare manifest demands configuration and offers nothing to install", () => {
    const bare = M.getUnconfiguredManifest(BASE_URL);
    expect(bare.behaviorHints.configurationRequired).toBe(true);
    expect(bare.behaviorHints.configurable).toBe(true);
    expect(bare.catalogs).toEqual([]);
  });

  test("a complete config is the only thing that clears it", () => {
    const complete = { sources: [{ provider: "currents", apiKey: KEY }], topics: ["top"] };
    expect(required(complete)).toBe(false);
    expect(isConfigured(complete)).toBe(true);
  });

  // Regression: topics alone used to clear configurationRequired, so a URL
  // carrying topics but no usable source installed cleanly and then showed
  // empty shelves forever.
  test.each([
    ["nothing at all", {}],
    ["a null config", null],
    ["an undefined config", undefined],
    ["topics but no sources", { topics: ["top", "technology"] }],
    ["topics but an empty sources list", { sources: [], topics: ["top"] }],
    ["topics but a source with no key", { sources: [{ provider: "currents", apiKey: "" }], topics: ["top"] }],
    ["topics but a whitespace-only key", { sources: [{ provider: "currents", apiKey: "   " }], topics: ["top"] }],
    ["topics but an unknown provider", { sources: [{ provider: "nope", apiKey: "k" }], topics: ["top"] }],
    ["topics but a non-array sources field", { sources: "currents", topics: ["top"] }],
    ["a source but no topics", { sources: [{ provider: "currents", apiKey: KEY }], topics: [] }],
    ["a source but no topics field", { sources: [{ provider: "currents", apiKey: KEY }] }],
    ["a source but only unknown topics", { sources: [{ provider: "currents", apiKey: KEY }], topics: ["nope"] }],
    ["a source but a non-array topics field", { sources: [{ provider: "currents", apiKey: KEY }], topics: "top" }]
  ])("still requires configuration with %s", (_label, cfg) => {
    expect(required(cfg)).toBe(true);
    expect(isConfigured(cfg)).toBe(false);
  });

  test("an incomplete config advertises no catalogs at all", () => {
    expect(catalogsFor({ topics: ["top", "technology"] })).toEqual([]);
    expect(catalogsFor({ sources: [], topics: ["top"] })).toEqual([]);
    expect(catalogsFor({ sources: [{ provider: "currents", apiKey: KEY }], topics: [] })).toEqual([]);
  });

  test("configurationRequired and an empty catalog list always agree", () => {
    [
      {},
      { topics: ["top"] },
      { sources: [], topics: ["top"] },
      { sources: [{ provider: "currents", apiKey: KEY }], topics: [] },
      { sources: [{ provider: "currents", apiKey: KEY }], topics: ["nope"] },
      { sources: [{ provider: "currents", apiKey: KEY }], topics: ["top"] }
    ].forEach((cfg) => {
      const m = M.buildManifest(cfg, BASE_URL);
      expect(m.behaviorHints.configurationRequired).toBe(m.catalogs.length === 0);
    });
  });

  test("stays configurable in every state, so Configure is always reachable", () => {
    [{}, { topics: ["top"] }, { sources: [{ provider: "currents", apiKey: KEY }], topics: ["top"] }].forEach((cfg) => {
      expect(M.buildManifest(cfg, BASE_URL).behaviorHints.configurable).toBe(true);
    });
    expect(M.getUnconfiguredManifest(BASE_URL).behaviorHints.configurable).toBe(true);
  });

  // The SDK builds a settings form from manifest.config and routes the
  // landing page to it, which would replace our own /configure page.
  test("no native config array, so Stremio opens our own configure page", () => {
    expect(M.getUnconfiguredManifest(BASE_URL).config).toBeUndefined();
    expect(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL).config).toBeUndefined();
  });

  test("behaviorHints carries exactly the two documented keys", () => {
    expect(Object.keys(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL).behaviorHints).sort()).toEqual([
      "configurable",
      "configurationRequired"
    ]);
  });
});

describe("stremio-addons.net listing credential", () => {
  // The exact token issued for https://newsio.up.railway.app/manifest.json,
  // pinned here independently of the source so a truncated copy/paste, a
  // stray newline from an editor, or a wrapped line in the constant fails
  // loudly rather than silently un-verifying the addon.
  const ISSUED_SIGNATURE =
    "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0." +
    "." +
    "Z71i61P4KsKCep97-S7_SA." +
    "NCWCuO1Mr-1HydcNM0IAJEzFCKshMaeEPGJ0Vai4YtrqUeiuDXGajDRisu4CpDawYYPVIMJA7Ay8G-1KJijCOM0c-" +
    "4OBAyFYinFCK_aQaBkvy49E_INGPuCHFPle8IST." +
    "f-bNhW5MzGrVuN-65LoHsg";

  test("ships by default, so the badge does not depend on an env var", () => {
    expect(M.getStremioAddonsConfig()).toEqual({
      issuer: "https://stremio-addons.net",
      signature: ISSUED_SIGNATURE
    });
  });

  test("the committed signature is exactly the one that was issued", () => {
    expect(M.STREMIO_ADDONS_SIGNATURE).toBe(ISSUED_SIGNATURE);
    expect(M.STREMIO_ADDONS_ISSUER).toBe("https://stremio-addons.net");
  });

  test("is on the plain unconfigured manifest -- the URL that gets claimed", () => {
    expect(M.getUnconfiguredManifest(BASE_URL).stremioAddonsConfig).toEqual({
      issuer: "https://stremio-addons.net",
      signature: ISSUED_SIGNATURE
    });
  });

  test("is on the configured manifest too", () => {
    expect(M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL).stremioAddonsConfig.signature).toBe(ISSUED_SIGNATURE);
  });

  test("is a well-formed compact JWE with a dir/A128CBC-HS256 header", () => {
    const parts = M.STREMIO_ADDONS_SIGNATURE.split(".");
    expect(parts).toHaveLength(5);
    expect(parts[1]).toBe(""); // alg=dir carries no encrypted key
    expect(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))).toEqual({
      alg: "dir",
      enc: "A128CBC-HS256"
    });
    parts.filter(Boolean).forEach((p) => expect(p).toMatch(/^[A-Za-z0-9_-]+$/));
  });

  test("carries no whitespace that would break the token in transit", () => {
    expect(M.STREMIO_ADDONS_SIGNATURE).not.toMatch(/\s/);
    expect(M.STREMIO_ADDONS_SIGNATURE.trim()).toBe(M.STREMIO_ADDONS_SIGNATURE);
  });

  test("survives a JSON round trip unchanged", () => {
    const m = JSON.parse(JSON.stringify(M.getUnconfiguredManifest(BASE_URL)));
    expect(m.stremioAddonsConfig.signature).toBe(ISSUED_SIGNATURE);
  });

  // A fork on another host needs its own token: this one is bound to the
  // manifest URL above and will not validate anywhere else.
  test("an env signature overrides the committed one", () => {
    process.env.STREMIO_ADDONS_CONFIG_SIGNATURE = "sig-abc";
    jest.resetModules();
    const M2 = require("../src/manifest");
    expect(M2.getUnconfiguredManifest(BASE_URL).stremioAddonsConfig).toEqual({
      issuer: "https://stremio-addons.net",
      signature: "sig-abc"
    });
  });

  test("honours a custom issuer override", () => {
    process.env.STREMIO_ADDONS_CONFIG_SIGNATURE = "s";
    process.env.STREMIO_ADDONS_CONFIG_ISSUER = "https://example.test";
    jest.resetModules();
    const M2 = require("../src/manifest");
    expect(M2.getStremioAddonsConfig().issuer).toBe("https://example.test");
  });

  test("an empty env signature falls back to the committed one", () => {
    process.env.STREMIO_ADDONS_CONFIG_SIGNATURE = "";
    jest.resetModules();
    const M2 = require("../src/manifest");
    expect(M2.getStremioAddonsConfig().signature).toBe(ISSUED_SIGNATURE);
  });
});

describe("internal interface manifest", () => {
  test("declares every topic plus search, so any catalog id routes to a handler", () => {
    const im = M.buildInterfaceManifest();
    expect(im.catalogs).toHaveLength(TOPICS.length + 1);
    expect(im.catalogs.map((c) => c.id).sort()).toEqual(
      [...TOPICS.map((t) => t.id), M.SEARCH_CATALOG_ID].sort()
    );
  });

  // The SDK builds one static router at startup, so the internal manifest
  // has to agree with what the served manifests advertise or a real request
  // would 404 on a catalog the user can see.
  test("internal search catalog matches the served one", () => {
    const internal = M.buildInterfaceManifest().catalogs.find((c) => c.id === M.SEARCH_CATALOG_ID);
    const served = M.buildManifest({ sources: [{ provider: "newsdata", apiKey: KEY }], topics: ["top"] }, BASE_URL).catalogs.find(
      (c) => c.id === M.SEARCH_CATALOG_ID
    );
    expect(internal).toEqual(served);
  });

  test("has a non-empty config array, which is what enables the SDK's :config route prefix", () => {
    expect(M.buildInterfaceManifest().config.length).toBeGreaterThan(0);
  });

  test("passes the official SDK manifest linter", () => {
    const { addonBuilder } = require("stremio-addon-sdk");
    expect(() => new addonBuilder(M.buildInterfaceManifest())).not.toThrow();
  });
});
