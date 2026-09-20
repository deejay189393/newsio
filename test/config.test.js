const { encodeConfig, decodeConfig } = require("../src/config");

describe("config encode/decode", () => {
  test("round-trips a normal config", () => {
    const cfg = { apiKey: "pub_abc123", topics: ["technology", "business"], language: "en" };
    expect(decodeConfig(encodeConfig(cfg))).toEqual(cfg);
  });

  test("produces a single URL path segment (no raw slashes)", () => {
    const encoded = encodeConfig({ apiKey: "a/b", topics: ["top"], language: "en" });
    expect(encoded).not.toContain("/");
  });

  test("round-trips after Express has already decoded the route param", () => {
    const cfg = { apiKey: "pub_abc/123 xyz?&=", topics: ["top"], language: "en" };
    const asExpressWouldGiveIt = decodeURIComponent(encodeConfig(cfg));
    expect(decodeConfig(asExpressWouldGiveIt)).toEqual(cfg);
  });

  test("round-trips non-ASCII characters", () => {
    const cfg = { apiKey: "pub_ünïcødé_✓", topics: ["top"], language: "de" };
    expect(decodeConfig(encodeConfig(cfg))).toEqual(cfg);
  });

  test("filters out invalid topic ids", () => {
    const encoded = encodeConfig({ apiKey: "x", topics: ["technology", "not-a-topic"], language: "en" });
    expect(decodeConfig(encoded).topics).toEqual(["technology"]);
  });

  test("falls back to English for an unrecognized language", () => {
    expect(decodeConfig(encodeConfig({ apiKey: "x", topics: ["top"], language: "xx-nope" })).language).toBe("en");
  });

  test("encodeConfig applies defaults for a sparse object", () => {
    expect(decodeConfig(encodeConfig({}))).toEqual({ apiKey: "", topics: [], language: "en" });
  });

  test("encodeConfig coerces a non-array topics value to []", () => {
    expect(decodeConfig(encodeConfig({ apiKey: "x", topics: "technology" })).topics).toEqual([]);
  });

  test("decode defaults topics to [] when missing or non-array", () => {
    expect(decodeConfig(encodeURIComponent(JSON.stringify({ apiKey: "x" }))).topics).toEqual([]);
    expect(decodeConfig(encodeURIComponent(JSON.stringify({ apiKey: "x", topics: 5 }))).topics).toEqual([]);
  });

  test("trims the apiKey and coerces a missing/non-string one to an empty string", () => {
    expect(decodeConfig(encodeURIComponent(JSON.stringify({ apiKey: "  x  " }))).apiKey).toBe("x");
    expect(decodeConfig(encodeURIComponent(JSON.stringify({ topics: [] }))).apiKey).toBe("");
    expect(decodeConfig(encodeURIComponent(JSON.stringify({ apiKey: 12345 }))).apiKey).toBe("");
  });

  test("returns null for empty/absent input", () => {
    expect(decodeConfig("")).toBeNull();
    expect(decodeConfig(null)).toBeNull();
    expect(decodeConfig(undefined)).toBeNull();
  });

  test("returns null for non-JSON input", () => {
    expect(decodeConfig("not json at all")).toBeNull();
    expect(decodeConfig("manifest.json")).toBeNull();
  });

  test("returns null when the JSON parses to a non-object", () => {
    expect(decodeConfig(encodeURIComponent(JSON.stringify("a string")))).toBeNull();
    expect(decodeConfig(encodeURIComponent(JSON.stringify(42)))).toBeNull();
    expect(decodeConfig(encodeURIComponent(JSON.stringify(null)))).toBeNull();
    expect(decodeConfig(encodeURIComponent(JSON.stringify(["a"])))).toBeNull();
  });

  test("survives a literal % that is not a valid percent-escape", () => {
    expect(() => decodeConfig("100% not json")).not.toThrow();
    expect(decodeConfig("100% not json")).toBeNull();
    // ...and still parses valid JSON that contains one
    expect(decodeConfig('{"apiKey":"100%","topics":[],"language":"en"}').apiKey).toBe("100%");
  });
});
