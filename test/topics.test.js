const { TOPICS, getTopicById, isValidTopicId, LANGUAGES, VALID_LANGUAGE_CODES } = require("../src/topics");

describe("topics", () => {
  test("every topic has a string id, category and label", () => {
    TOPICS.forEach((t) => {
      expect(typeof t.id).toBe("string");
      expect(typeof t.category).toBe("string");
      expect(typeof t.label).toBe("string");
      expect(t.label.length).toBeGreaterThan(0);
    });
  });

  test("topic ids are unique", () => {
    const ids = TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("covers the topics named in the brief (technology, finance)", () => {
    expect(isValidTopicId("technology")).toBe(true);
    expect(getTopicById("business").label).toMatch(/Finance/);
  });

  test("getTopicById returns the full topic record", () => {
    expect(getTopicById("technology")).toEqual({
      id: "technology",
      category: "technology",
      label: "Technology"
    });
  });

  test("getTopicById returns undefined for an unknown id", () => {
    expect(getTopicById("not-a-topic")).toBeUndefined();
    expect(getTopicById("")).toBeUndefined();
    expect(getTopicById(undefined)).toBeUndefined();
  });

  test("isValidTopicId reflects TOPICS membership", () => {
    expect(isValidTopicId("business")).toBe(true);
    expect(isValidTopicId("fake")).toBe(false);
  });

  test("languages have unique codes and labels", () => {
    LANGUAGES.forEach((l) => {
      expect(typeof l.code).toBe("string");
      expect(typeof l.label).toBe("string");
    });
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("VALID_LANGUAGE_CODES matches LANGUAGES exactly", () => {
    expect(VALID_LANGUAGE_CODES.size).toBe(LANGUAGES.length);
    LANGUAGES.forEach((l) => expect(VALID_LANGUAGE_CODES.has(l.code)).toBe(true));
    expect(VALID_LANGUAGE_CODES.has("xx")).toBe(false);
  });
});
