const { encodeConfig, decodeConfig, normalizeSources, isConfigured, unusedProviders, youtubeNewsEnabled, maxAgeDays } = require("../src/config");

const CUR = { provider: "currents", apiKey: "cur-key" };
const ND = { provider: "newsdata", apiKey: "nd-key" };

describe("the YouTube stream options", () => {
  const {
    normalizeYoutubeStreams,
    youtubeStreamsOf,
    DEFAULT_YOUTUBE_STREAMS,
    YOUTUBE_STREAMS_VERSION
  } = require("../src/youtubeStreams");
  const V = YOUTUBE_STREAMS_VERSION;

  test("nothing saved means in-app first, the YouTube app, then direct from YouTube", () => {
    // SmartTube is off by default: it is a separately installed app, and an
    // option that opens nothing is the dead row this addon keeps removing.
    // Direct-from-YouTube is on but last until Nuvio ships support for it.
    expect(DEFAULT_YOUTUBE_STREAMS).toEqual(["app", "youtube", "ytid"]);
    expect(normalizeYoutubeStreams(undefined)).toEqual(["app", "youtube", "ytid"]);
    expect(youtubeStreamsOf(undefined)).toEqual(["app", "youtube", "ytid"]);
  });

  test("the current version is 2", () => {
    expect(V).toBe(2);
  });

  test("a list saved at the current version is kept exactly, including all four", () => {
    expect(normalizeYoutubeStreams(["ytid", "smarttube", "youtube", "app"], undefined, V)).toEqual([
      "ytid",
      "smarttube",
      "youtube",
      "app"
    ]);
  });

  test("at the current version a single option is allowed, which is the point of the toggles", () => {
    expect(normalizeYoutubeStreams(["app"], undefined, V)).toEqual(["app"]);
    expect(normalizeYoutubeStreams(["smarttube"], undefined, V)).toEqual(["smarttube"]);
    expect(normalizeYoutubeStreams(["ytid"], undefined, V)).toEqual(["ytid"]);
  });

  test("a list saved before direct-from-YouTube existed gains it at the bottom", () => {
    // Every addon installed before this has a list and no version: it never
    // had the chance to include the new option, so it is not "turned off".
    expect(normalizeYoutubeStreams(["app", "youtube"])).toEqual(["app", "youtube", "ytid"]);
    expect(normalizeYoutubeStreams(["smarttube", "youtube", "app"])).toEqual([
      "smarttube",
      "youtube",
      "app",
      "ytid"
    ]);
    expect(normalizeYoutubeStreams(["app"])).toEqual(["app", "ytid"]);
    expect(normalizeYoutubeStreams(["app"], undefined, 1)).toEqual(["app", "ytid"]);
  });

  test("an old list that somehow already names it is not given it twice", () => {
    expect(normalizeYoutubeStreams(["ytid", "app"])).toEqual(["ytid", "app"]);
  });

  test("a version that is not a number is read as old", () => {
    for (const bad of ["two", null, {}, NaN]) {
      expect(normalizeYoutubeStreams(["app"], undefined, bad)).toEqual(["app", "ytid"]);
    }
    expect(normalizeYoutubeStreams(["app"], undefined, "2")).toEqual(["app"]);
    expect(normalizeYoutubeStreams(["app"], undefined, 3)).toEqual(["app"]);
  });

  test("unknown ids and duplicates are dropped, order otherwise untouched", () => {
    expect(normalizeYoutubeStreams(["youtube", "nope", "youtube", 7, null, "app"], undefined, V)).toEqual([
      "youtube",
      "app"
    ]);
  });

  test("turning everything off falls back rather than leaving nothing to play", () => {
    expect(normalizeYoutubeStreams([], undefined, V)).toEqual(["app", "youtube", "ytid"]);
    expect(normalizeYoutubeStreams(["nope"])).toEqual(["app", "youtube", "ytid"]);
  });

  test("the older single-choice setting is migrated, not ignored, and gains the new option", () => {
    // An addon installed before this existed carries youtubePlayback in its
    // URL; ignoring it would silently reorder someone's play button.
    expect(normalizeYoutubeStreams(undefined, "app")).toEqual(["app", "youtube", "ytid"]);
    expect(normalizeYoutubeStreams(undefined, "youtube")).toEqual(["youtube", "app", "ytid"]);
    expect(normalizeYoutubeStreams(undefined, "nonsense")).toEqual(["app", "youtube", "ytid"]);
  });

  test("an explicit list wins over the legacy setting", () => {
    expect(normalizeYoutubeStreams(["smarttube"], "youtube", V)).toEqual(["smarttube"]);
  });

  test("youtubeStreamsOf reads the list, the legacy setting and the version together", () => {
    expect(youtubeStreamsOf({ youtubePlayback: "youtube" })).toEqual(["youtube", "app", "ytid"]);
    expect(youtubeStreamsOf({ youtubeStreams: ["youtube"] })).toEqual(["youtube", "ytid"]);
    expect(youtubeStreamsOf({ youtubeStreams: ["youtube"], youtubeStreamsVersion: 2 })).toEqual(["youtube"]);
  });

  test("a current list survives the round trip, and records its version", () => {
    const encoded = encodeConfig({
      sources: [CUR],
      topics: ["top"],
      youtubeStreams: ["smarttube", "app"],
      youtubeStreamsVersion: V
    });
    expect(JSON.parse(decodeURIComponent(encoded)).youtubeStreamsVersion).toBe(V);
    const back = decodeConfig(encoded);
    expect(back.youtubeStreams).toEqual(["smarttube", "app"]);
    expect(back.youtubeStreamsVersion).toBe(V);
  });

  test("turning direct-from-YouTube off sticks, however many times the config is re-saved", () => {
    let config = { sources: [CUR], topics: ["top"], youtubeStreams: ["app", "youtube"], youtubeStreamsVersion: V };
    for (let i = 0; i < 3; i++) config = decodeConfig(encodeConfig(config));
    expect(config.youtubeStreams).toEqual(["app", "youtube"]);
  });

  test("an install URL from before this version decodes with the new option added", () => {
    const old = JSON.stringify({ sources: [CUR], topics: ["top"], youtubeStreams: ["youtube", "app"] });
    const back = decodeConfig(old);
    expect(back.youtubeStreams).toEqual(["youtube", "app", "ytid"]);
    // ...and from then on it is a current list that keeps what it has.
    expect(decodeConfig(encodeConfig(back)).youtubeStreams).toEqual(["youtube", "app", "ytid"]);
  });

  test("a legacy config round-trips into the migrated list", () => {
    const back = decodeConfig(encodeConfig({ sources: [CUR], topics: ["top"], youtubePlayback: "youtube" }));
    expect(back.youtubeStreams).toEqual(["youtube", "app", "ytid"]);
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
      youtubeStreams: ["app", "youtube", "ytid"],
      youtubeStreamsVersion: 2,
      youtubeNews: true,
      maxAgeDays: 30
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
      youtubeStreams: ["app", "youtube", "ytid"],
      youtubeStreamsVersion: 2,
      youtubeNews: true,
      maxAgeDays: 30
    });
  });

  test("applies defaults to a sparse object", () => {
    expect(decodeConfig(encodeConfig({}))).toEqual({
      sources: [],
      topics: [],
      language: "en",
      youtubeStreams: ["app", "youtube", "ytid"],
      youtubeStreamsVersion: 2,
      youtubeNews: true,
      maxAgeDays: 30
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

describe("keeping YouTube searches to news", () => {
  const YT = { provider: "youtube", apiKey: "AIza-key" };

  test("is on for every addon installed before the setting existed", () => {
    expect(decodeConfig(JSON.stringify({ sources: [YT], topics: ["top"] })).youtubeNews).toBe(true);
    expect(youtubeNewsEnabled({ sources: [YT] })).toBe(true);
  });

  test("is on for no config at all", () => {
    expect(youtubeNewsEnabled(undefined)).toBe(true);
    expect(youtubeNewsEnabled(null)).toBe(true);
  });

  test("only an explicit false turns it off", () => {
    expect(youtubeNewsEnabled({ youtubeNews: false })).toBe(false);
    expect(youtubeNewsEnabled({ youtubeNews: true })).toBe(true);
    // A hand-edited URL with something else in it keeps the default.
    for (const value of ["false", 0, null, "", "no"]) {
      expect(youtubeNewsEnabled({ youtubeNews: value })).toBe(true);
    }
  });

  test("decoding keeps it off when the URL says so", () => {
    const back = decodeConfig(JSON.stringify({ sources: [YT], topics: ["top"], youtubeNews: false }));
    expect(back.youtubeNews).toBe(false);
  });

  test("is left out of the URL while it is on, so existing URLs do not change", () => {
    const encoded = decodeURIComponent(encodeConfig({ sources: [YT], topics: ["top"] }));
    expect(JSON.parse(encoded)).not.toHaveProperty("youtubeNews");
    const explicit = decodeURIComponent(encodeConfig({ sources: [YT], topics: ["top"], youtubeNews: true }));
    expect(JSON.parse(explicit)).not.toHaveProperty("youtubeNews");
  });

  test("is written into the URL as false when it is off, and survives the round trip", () => {
    const encoded = encodeConfig({ sources: [YT], topics: ["top"], youtubeNews: false });
    expect(JSON.parse(decodeURIComponent(encoded)).youtubeNews).toBe(false);
    expect(decodeConfig(encoded).youtubeNews).toBe(false);
  });
});

describe("how far back stories may go", () => {
  const YT = { provider: "youtube", apiKey: "AIza-key" };

  test("is 30 days when not set, including for every addon installed before it existed", () => {
    expect(maxAgeDays({})).toBe(30);
    expect(maxAgeDays(undefined)).toBe(30);
    expect(decodeConfig(JSON.stringify({ sources: [YT], topics: ["top"] })).maxAgeDays).toBe(30);
  });

  test("takes any whole number of days from 0 up, with no upper limit", () => {
    for (const days of [0, 1, 7, 30, 365, 100000]) {
      expect(maxAgeDays({ maxAgeDays: days })).toBe(days);
    }
  });

  test("accepts a number written as a string in a hand-edited URL", () => {
    expect(maxAgeDays({ maxAgeDays: "7" })).toBe(7);
    expect(maxAgeDays({ maxAgeDays: "0" })).toBe(0);
  });

  test("falls back to 30 for anything that is not a whole number of days", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, "abc", "", "  ", "-3", "2.5", null, true, [], {}, 2 ** 60]) {
      expect(maxAgeDays({ maxAgeDays: bad })).toBe(30);
    }
  });

  test("is left out of the URL at the default, so existing URLs do not change", () => {
    const encoded = decodeURIComponent(encodeConfig({ sources: [YT], topics: ["top"], maxAgeDays: 30 }));
    expect(JSON.parse(encoded)).not.toHaveProperty("maxAgeDays");
  });

  test("is written into the URL when changed, 0 included, and survives the round trip", () => {
    for (const days of [0, 7, 365]) {
      const encoded = encodeConfig({ sources: [YT], topics: ["top"], maxAgeDays: days });
      expect(JSON.parse(decodeURIComponent(encoded)).maxAgeDays).toBe(days);
      expect(decodeConfig(encoded).maxAgeDays).toBe(days);
    }
  });
});
