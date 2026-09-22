const { normalizeRange } = require("../src/byteRange");

const LENGTH = 41631345; // a real itag 18 file

describe("suffix ranges, which googlevideo refuses", () => {
  test("the last N bytes become an absolute range", () => {
    // Measured live: bytes=-2000 returns 416 on a URL where the absolute
    // equivalent returns 206. This is what makes seeking possible.
    expect(normalizeRange("bytes=-2000", LENGTH)).toBe(`bytes=${LENGTH - 2000}-${LENGTH - 1}`);
  });

  test("the final byte is the last one that exists, not one past it", () => {
    // An off-by-one here is a 416 from upstream and a failed seek.
    expect(normalizeRange("bytes=-1", LENGTH)).toBe(`bytes=${LENGTH - 1}-${LENGTH - 1}`);
  });

  test("asking for more than exists means the whole file", () => {
    expect(normalizeRange("bytes=-99999999", LENGTH)).toBe(`bytes=0-${LENGTH - 1}`);
    expect(normalizeRange(`bytes=-${LENGTH}`, LENGTH)).toBe(`bytes=0-${LENGTH - 1}`);
  });

  test("case and surrounding space do not hide it", () => {
    expect(normalizeRange("BYTES=-500", LENGTH)).toBe(`bytes=${LENGTH - 500}-${LENGTH - 1}`);
    expect(normalizeRange("  bytes=-500  ", LENGTH)).toBe(`bytes=${LENGTH - 500}-${LENGTH - 1}`);
  });
});

describe("ranges that are already fine are left exactly alone", () => {
  test.each([
    ["bytes=1000-2000"],
    ["bytes=5000000-"],
    ["bytes=0-"],
    ["bytes=0-0"]
  ])("%p passes through unchanged", (range) => {
    expect(normalizeRange(range, LENGTH)).toBe(range);
  });

  test("a multi-range request is upstream's problem, not ours to rewrite", () => {
    expect(normalizeRange("bytes=0-1,5-9", LENGTH)).toBe("bytes=0-1,5-9");
    expect(normalizeRange("bytes=-100,-200", LENGTH)).toBe("bytes=-100,-200");
  });

  test("a unit we do not understand is not touched", () => {
    expect(normalizeRange("items=-5", LENGTH)).toBe("items=-5");
    expect(normalizeRange("seconds=-5", LENGTH)).toBe("seconds=-5");
  });
});

describe("when the arithmetic cannot be done", () => {
  test.each([[null], [undefined], [0], [-1], ["nonsense"], [NaN]])(
    "an unusable length %p leaves the header for upstream to judge",
    (length) => {
      expect(normalizeRange("bytes=-2000", length)).toBe("bytes=-2000");
    }
  );

  test("the last zero bytes is unsatisfiable, and stays that way", () => {
    // Inventing a range here would silently mean something else.
    expect(normalizeRange("bytes=-0", LENGTH)).toBe("bytes=-0");
  });

  test.each([[undefined], [null], [""], [42], [{}]])("a non-header %p is returned as given", (range) => {
    expect(normalizeRange(range, LENGTH)).toBe(range);
  });
});
