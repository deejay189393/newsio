const {
  PRESET_TOPICS,
  CUSTOM_PREFIX,
  MAX_CUSTOM_TOPICS,
  MAX_QUERY_LENGTH,
  isPresetTopicId,
  getPresetTopic,
  getTopicLabel,
  isCustomTopicId,
  customTopicId,
  tidyQuery,
  normalizeTopics,
  toStoredTopics
} = require("../src/topics");

describe("preset topics", () => {
  test("every preset has a unique id and a label", () => {
    const ids = PRESET_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    PRESET_TOPICS.forEach((t) => expect(typeof t.label).toBe("string"));
  });

  test("no preset id could be mistaken for a custom one", () => {
    PRESET_TOPICS.forEach((t) => expect(t.id.startsWith(CUSTOM_PREFIX)).toBe(false));
  });

  test("lookup helpers", () => {
    expect(isPresetTopicId("technology")).toBe(true);
    expect(isPresetTopicId("q_london")).toBe(false);
    expect(isPresetTopicId("nope")).toBe(false);
    expect(getPresetTopic("top").label).toBe("Top Stories");
    expect(getPresetTopic("nope")).toBeUndefined();
    expect(getTopicLabel("business")).toBe("Finance & Business");
    expect(getTopicLabel("nope")).toBeNull();
  });

  test("Video News is offered as a topic of its own", () => {
    expect(PRESET_TOPICS.some((t) => t.id === "video" && t.label === "Video News")).toBe(true);
  });

  // Dropped as a preset: every provider mapped it to its catch-all feed, so
  // it was a second, vaguer copy of Top Stories rather than a subject.
  test('"other" is no longer a topic', () => {
    expect(isPresetTopicId("other")).toBe(false);
    expect(PRESET_TOPICS.some((t) => t.id === "other")).toBe(false);
  });

  test("a config still carrying it simply drops it, keeping the rest", () => {
    expect(normalizeTopics(["top", "other", "technology"]).map((t) => t.id)).toEqual(["top", "technology"]);
  });

  test('"other" can still be had as a custom topic, if anyone wants it', () => {
    expect(normalizeTopics([{ q: "other" }]).map((t) => t.id)).toEqual(["q_other"]);
  });
});

describe("tidyQuery", () => {
  test.each([
    ["  London crime  ", "London crime"],
    ["London    crime", "London crime"],
    ["London\tcrime", "London crime"],
    ["London\n crime", "London crime"]
  ])("%p tidies to %p", (raw, tidy) => {
    expect(tidyQuery(raw)).toBe(tidy);
  });

  test.each([[null], [undefined], [42], [{}]])("%p tidies to an empty string", (raw) => {
    expect(tidyQuery(raw)).toBe("");
  });
});

describe("customTopicId", () => {
  // Derived from the text rather than random: re-saving an unchanged config
  // must not orphan the catalogs Stremio has already installed.
  test("is stable for the same query", () => {
    expect(customTopicId("London crime")).toBe(customTopicId("London crime"));
    expect(customTopicId("London crime")).toBe("q_london-crime");
  });

  test("ignores casing and spacing differences", () => {
    expect(customTopicId("  LONDON   Crime ")).toBe("q_london-crime");
  });

  test.each([
    ["semiconductor exports", "q_semiconductor-exports"],
    ["AI & chips", "q_ai-chips"],
    ["Arsenal", "q_arsenal"],
    ["covid-19", "q_covid-19"],
    ["2026 elections", "q_2026-elections"]
  ])("%p becomes %p", (query, id) => {
    expect(customTopicId(query)).toBe(id);
  });

  test("is URL-safe", () => {
    expect(customTopicId("a/b?c=d&e f")).toMatch(/^q_[a-z0-9-]+$/);
  });

  test.each([["!!!"], ["   "], ["---"], [""]])("%p has nothing to search for", (query) => {
    expect(customTopicId(query)).toBeNull();
  });
});

describe("normalizeTopics", () => {
  const ids = (raw) => normalizeTopics(raw).map((t) => t.id);

  test("accepts a preset as a bare string or an object", () => {
    expect(ids(["technology", { id: "top" }])).toEqual(["technology", "top"]);
  });

  test("accepts a custom topic as { q } or { query }", () => {
    expect(ids([{ q: "London crime" }, { query: "AI chips" }])).toEqual(["q_london-crime", "q_ai-chips"]);
  });

  // The order is the setting: it decides catalog order in the manifest.
  test("preserves order exactly, presets and customs interleaved", () => {
    expect(ids(["top", { q: "London crime" }, "technology", { q: "Arsenal" }])).toEqual([
      "top",
      "q_london-crime",
      "technology",
      "q_arsenal"
    ]);
  });

  test("labels a custom topic with the text the user typed", () => {
    expect(normalizeTopics([{ q: "London crime" }])[0]).toEqual({
      kind: "custom",
      id: "q_london-crime",
      label: "London crime",
      query: "London crime"
    });
  });

  test("marks which kind each topic is", () => {
    expect(normalizeTopics(["top", { q: "x y" }]).map((t) => t.kind)).toEqual(["preset", "custom"]);
  });

  test("drops duplicates, keeping the first position", () => {
    expect(ids(["top", "technology", "top"])).toEqual(["top", "technology"]);
    expect(ids([{ q: "London crime" }, { q: "  london   CRIME " }])).toEqual(["q_london-crime"]);
  });

  test("a custom topic cannot collide with a preset id", () => {
    // "q_" prefixing is what guarantees this.
    expect(ids([{ q: "technology" }, "technology"])).toEqual(["q_technology", "technology"]);
  });

  test.each([
    ["an unknown preset", ["nope"]],
    ["an empty query", [{ q: "" }]],
    ["a whitespace query", [{ q: "   " }]],
    ["a punctuation-only query", [{ q: "!!!" }]],
    ["a null entry", [null]],
    ["a number entry", [42]],
    ["a boolean entry", [true]],
    ["an empty object", [{}]],
    ["a non-string query", [{ q: 42 }]]
  ])("drops %s", (_label, raw) => {
    expect(normalizeTopics(raw)).toEqual([]);
  });

  test.each([[undefined], [null], ["technology"], [42], [{}]])("%p yields no topics", (raw) => {
    expect(normalizeTopics(raw)).toEqual([]);
  });

  test("keeps the good entries alongside the bad", () => {
    expect(ids(["nope", "top", null, { q: "!!!" }, { q: "Arsenal" }])).toEqual(["top", "q_arsenal"]);
  });

  test("refuses a query longer than the limit", () => {
    expect(normalizeTopics([{ q: "x".repeat(MAX_QUERY_LENGTH) }])).toHaveLength(1);
    expect(normalizeTopics([{ q: "x".repeat(MAX_QUERY_LENGTH + 1) }])).toEqual([]);
  });

  test("caps how many custom topics are accepted, without capping presets", () => {
    const many = Array.from({ length: MAX_CUSTOM_TOPICS + 5 }, (_, i) => ({ q: `topic number ${i}` }));
    expect(normalizeTopics(many)).toHaveLength(MAX_CUSTOM_TOPICS);

    const mixed = [...PRESET_TOPICS.map((t) => t.id), ...many];
    const out = normalizeTopics(mixed);
    expect(out.filter((t) => t.kind === "preset")).toHaveLength(PRESET_TOPICS.length);
    expect(out.filter((t) => t.kind === "custom")).toHaveLength(MAX_CUSTOM_TOPICS);
  });

  test("the cap keeps the earliest custom topics, not the last", () => {
    const many = Array.from({ length: MAX_CUSTOM_TOPICS + 3 }, (_, i) => ({ q: `topic number ${i}` }));
    expect(normalizeTopics(many)[0].query).toBe("topic number 0");
  });
});

describe("isCustomTopicId", () => {
  test.each([
    ["q_london-crime", true],
    ["q_", true],
    ["technology", false],
    ["", false],
    [null, false],
    [undefined, false],
    [42, false]
  ])("%p -> %p", (id, expected) => {
    expect(isCustomTopicId(id)).toBe(expected);
  });
});

describe("toStoredTopics — the compact form kept in the URL", () => {
  test("a preset stores as its id, a custom as its query", () => {
    const topics = normalizeTopics(["top", { q: "London crime" }]);
    expect(toStoredTopics(topics)).toEqual(["top", { q: "London crime" }]);
  });

  test("a stored list round-trips through normalize unchanged", () => {
    const original = ["top", { q: "London crime" }, "technology"];
    const once = normalizeTopics(original);
    expect(toStoredTopics(once)).toEqual(original);
    expect(normalizeTopics(toStoredTopics(once))).toEqual(once);
  });

  test("an empty list stores as an empty list", () => {
    expect(toStoredTopics([])).toEqual([]);
  });
});
