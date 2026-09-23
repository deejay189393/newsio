const { encodeConfig, decodeConfig, normalizeSources, isConfigured, unusedProviders } = require("../src/config");

const CUR = { provider: "currents", apiKey: "cur-key" };
const ND = { provider: "newsdata", apiKey: "nd-key" };

describe("the YouTube stream options", () => {
  const { normalizeYoutubeStreams, DEFAULT_YOUTUBE_STREAMS } = require("../src/youtubeStreams");

  test("nothing saved means in-app first, then the YouTube app", () => {
    // SmartTube is off by default: it is a separately installed app, and an
    // option that opens nothing is the dead row this addon keeps removing.
    expect(DEFAULT_YOUTUBE_STREAMS).toEqual(["app", "youtube"]);
    expect(normalizeYoutubeStreams(undefined)).toEqual(["app", "youtube"]);
  });

  test("the saved order is kept exactly, including all three", () => {
    expect(normalizeYoutubeStreams(["smarttube", "youtube", "app"])).toEqual([
      "smarttube",
      "youtube",
      "app"
    ]);
  });

  test("a single option is allowed, which is the point of the toggles", () => {
    expect(normalizeYoutubeStreams(["app"])).toEqual(["app"]);
    expect(normalizeYoutubeStreams(["smarttube"])).toEqual(["smarttube"]);
  });

  test("unknown ids and duplicates are dropped, order otherwise untouched", () => {
    expect(normalizeYoutubeStreams(["youtube", "nope", "youtube", 7, null, "app"])).toEqual([
      "youtube",
      "app"
    ]);
  });

  test("turning everything off falls back rather than leaving nothing to play", () => {
    expect(normalizeYoutubeStreams([])).toEqual(["app", "youtube"]);
    expect(normalizeYoutubeStreams(["nope"])).toEqual(["app", "youtube"]);
  });

  test("the older single-choice setting is migrated, not ignored", () => {
    // An addon installed before this existed carries youtubePlayback in its
    // URL; ignoring it would silently reorder someone's play button.
    expect(normalizeYoutubeStreams(undefined, "app")).toEqual(["app", "youtube"]);
    expect(normalizeYoutubeStreams(undefined, "youtube")).toEqual(["youtube", "app"]);
    expect(normalizeYoutubeStreams(undefined, "nonsense")).toEqual(["app", "youtube"]);
  });

  test("an explicit list wins over the legacy setting", () => {
    expect(normalizeYoutubeStreams(["smarttube"], "youtube")).toEqual(["smarttube"]);
  });

  test("it survives the round trip", () => {
    const back = decodeConfig(
      encodeConfig({ sources: [CUR], topics: ["top"], youtubeStreams: ["smarttube", "app"] })
    );
    expect(back.youtubeStreams).toEqual(["smarttube", "app"]);
  });

  test("a legacy config round-trips into the migrated list", () => {
    const back = decodeConfig(encodeConfig({ sources: [CUR], topics: ["top"], youtubePlayback: "youtube" }));
    expect(back.youtubeStreams).toEqual(["youtube", "app"]);
  });
});

describe("encode / decode round trip", () => {
  test("a normal config survives intact", () => {
    const cfg = { sources: [CUR, ND], topics: ["technology", "top"], language: "fr" };
    expect(decodeConfig(encodeConfig(cfg))).toEqual({
      sources: [CUR, ND],
      topics: [
        { kind: "preset", id: "technology", label: "Technology" },
        { kind: "preset", id: "top", label: "Top Stories" }
      ],
      language: "fr",
      youtubeStreams: ["app", "youtube"]
    });
  });

  test("survives Express having already decoded the route param", () => {
    const encoded = encodeConfig({ sources: [CUR], topics: ["top"], language: "en" });
    expect(decodeConfig(decodeURIComponent(encoded))).toEqual(decodeConfig(encoded));
  });

  test("survives non-ASCII in a key and in a custom topic", () => {
    const cfg = {
      sources: [{ provider: "currents", apiKey: "clé-éñ-日本" }],
      topics: [{ q: "café culture" }],
      language: "en"
    };
    const back = decodeConfig(encodeConfig(cfg));
    expect(back.sources[0].apiKey).toBe("clé-éñ-日本");
    expect(back.topics[0].query).toBe("café culture");
  });

  test("the config is a single path segment", () => {
    expect(encodeConfig({ sources: [CUR], topics: ["top"], language: "en" })).not.toContain("/");
  });

  test("survives a literal % that is not a valid escape", () => {
    expect(decodeConfig('{"sources":[{"provider":"currents","apiKey":"100%"}],"topics":["top"]}')).toEqual({
      sources: [{ provider: "currents", apiKey: "100%" }],
      topics: [{ kind: "preset", id: "top", label: "Top Stories" }],
      language: "en",
      youtubeStreams: ["app", "youtube"]
    });
  });

  test("applies defaults to a sparse object", () => {
    expect(decodeConfig(encodeConfig({}))).toEqual({
      sources: [],
      topics: [],
      language: "en",
      youtubeStreams: ["app", "youtube"]
    });
  });
});

describe("decodeConfig rejects what is not our shape", () => {
  test.each([
    ["an empty segment", ""],
    ["null", null],
    ["undefined", undefined],
    ["not JSON at all", "garbage-not-json"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON string", '"hello"'],
    ["JSON null", "null"],
    ["a JSON number", "42"]
  ])("%s decodes to null", (_label, raw) => {
    expect(decodeConfig(raw)).toBeNull();
  });
});

describe("normalizeSources — the failover chain", () => {
  test("keeps the user's order, because the order is the setting", () => {
    expect(normalizeSources([ND, CUR]).map((s) => s.provider)).toEqual(["newsdata", "currents"]);
    expect(normalizeSources([CUR, ND]).map((s) => s.provider)).toEqual(["currents", "newsdata"]);
  });

  test("trims keys", () => {
    expect(normalizeSources([{ provider: "currents", apiKey: "  k  " }])[0].apiKey).toBe("k");
  });

  // Two keys for the same API would fail over into the same quota.
  test("allows each provider only once, keeping the first", () => {
    const out = normalizeSources([CUR, { provider: "currents", apiKey: "second" }, ND]);
    expect(out).toEqual([CUR, ND]);
  });

  test.each([
    ["an unknown provider", { provider: "nope", apiKey: "k" }],
    ["a missing key", { provider: "currents", apiKey: "" }],
    ["a whitespace-only key", { provider: "currents", apiKey: "   " }],
    ["a non-string key", { provider: "currents", apiKey: 42 }],
    ["a missing provider", { apiKey: "k" }],
    ["a null entry", null],
    ["a string entry", "currents"],
    ["a number entry", 7]
  ])("drops %s", (_label, entry) => {
    expect(normalizeSources([entry])).toEqual([]);
  });

  test.each([[undefined], [null], ["currents"], [42], [{}]])("%p yields an empty chain", (sources) => {
    expect(normalizeSources(sources)).toEqual([]);
  });

  test("keeps the good entries alongside the bad", () => {
    expect(normalizeSources([{ provider: "nope", apiKey: "k" }, CUR, null, ND])).toEqual([CUR, ND]);
  });
});

describe("topics and language validation", () => {
  test("unknown topics are dropped, known ones kept in order", () => {
    expect(
      decodeConfig(JSON.stringify({ topics: ["nope", "technology", "bogus", "top"] })).topics.map((t) => t.id)
    ).toEqual(["technology", "top"]);
  });

  test.each([["en"], ["fr"], ["ja"]])("keeps the supported language %p", (language) => {
    expect(decodeConfig(JSON.stringify({ language })).language).toBe(language);
  });

  test.each([["klingon"], [42], [null], [undefined], [""]])("falls back to English for %p", (language) => {
    expect(decodeConfig(JSON.stringify({ language })).language).toBe("en");
  });
});

describe("isConfigured", () => {
  test("needs both a usable source and a topic", () => {
    expect(isConfigured({ sources: [CUR], topics: ["top"] })).toBe(true);
    expect(isConfigured({ sources: [CUR], topics: [] })).toBe(false);
    expect(isConfigured({ sources: [], topics: ["top"] })).toBe(false);
    expect(isConfigured({})).toBe(false);
    expect(isConfigured(null)).toBe(false);
  });

  test("a source that normalizes away does not count", () => {
    expect(isConfigured({ sources: [{ provider: "currents", apiKey: "  " }], topics: ["top"] })).toBe(false);
    expect(isConfigured({ sources: [{ provider: "nope", apiKey: "k" }], topics: ["top"] })).toBe(false);
  });

  test("a topic that normalizes away does not count", () => {
    expect(isConfigured({ sources: [CUR], topics: ["nope"] })).toBe(false);
    expect(isConfigured({ sources: [CUR], topics: [{ q: "!!!" }] })).toBe(false);
  });

  test("a custom topic alone is enough", () => {
    expect(isConfigured({ sources: [CUR], topics: [{ q: "London crime" }] })).toBe(true);
  });
});

describe("a source that needs no key", () => {
  test("NewsMCP is kept with no key at all, as a keyless source", () => {
    expect(normalizeSources([{ provider: "newsmcp" }])).toEqual([{ provider: "newsmcp", apiKey: "" }]);
    expect(normalizeSources([{ provider: "newsmcp", apiKey: "   " }])).toEqual([{ provider: "newsmcp", apiKey: "" }]);
  });

  test("its optional key is kept, trimmed", () => {
    expect(normalizeSources([{ provider: "newsmcp", apiKey: " k1 " }])).toEqual([{ provider: "newsmcp", apiKey: "k1" }]);
  });

  test("a keyed provider with no key is still dropped", () => {
    expect(normalizeSources([{ provider: "currents" }, { provider: "gnews", apiKey: "" }])).toEqual([]);
  });

  test("it still appears only once", () => {
    expect(normalizeSources([{ provider: "newsmcp" }, { provider: "newsmcp", apiKey: "k" }])).toEqual([
      { provider: "newsmcp", apiKey: "" }
    ]);
  });

  test("on its own it makes a complete setup", () => {
    expect(isConfigured({ sources: [{ provider: "newsmcp" }], topics: ["top"] })).toBe(true);
  });

  test("it is stored without an empty key, and decodes back to the same thing", () => {
    const encoded = encodeConfig({ sources: [{ provider: "newsmcp" }, CUR], topics: ["top"], language: "en" });
    expect(JSON.parse(decodeURIComponent(encoded)).sources).toEqual([{ provider: "newsmcp" }, CUR]);
    expect(decodeConfig(encoded).sources).toEqual([{ provider: "newsmcp", apiKey: "" }, CUR]);
  });

  test("with a key it is stored with that key", () => {
    const encoded = encodeConfig({ sources: [{ provider: "newsmcp", apiKey: "k1" }], topics: ["top"] });
    expect(JSON.parse(decodeURIComponent(encoded)).sources).toEqual([{ provider: "newsmcp", apiKey: "k1" }]);
  });
});

describe("unusedProviders", () => {
  test("lists what the user has not configured yet", () => {
    expect(unusedProviders({ sources: [CUR] }).map((p) => p.id)).toEqual(["youtube", "newsmcp", "newsdata", "gnews"]);
    expect(unusedProviders({ sources: [CUR, ND] }).map((p) => p.id)).toEqual(["youtube", "newsmcp", "gnews"]);
  });

  test("lists everything when nothing is configured", () => {
    expect(unusedProviders({}).map((p) => p.id)).toEqual(["youtube", "newsmcp", "currents", "newsdata", "gnews"]);
    expect(unusedProviders(null).map((p) => p.id)).toEqual(["youtube", "newsmcp", "currents", "newsdata", "gnews"]);
  });
});

describe("keys are never persisted", () => {
  test("the whole config lives in the URL segment and nowhere else", () => {
    const encoded = encodeConfig({ sources: [CUR, ND], topics: ["top"], language: "en" });
    const decoded = JSON.parse(decodeURIComponent(encoded));
    expect(decoded.sources.map((s) => s.apiKey)).toEqual(["cur-key", "nd-key"]);
  });
});
