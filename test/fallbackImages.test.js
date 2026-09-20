const { FALLBACK_POSTER, FALLBACK_BACKGROUND } = require("../src/fallbackImages");

describe("fallbackImages", () => {
  test("both are inline SVG data URIs", () => {
    expect(FALLBACK_POSTER).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(FALLBACK_BACKGROUND).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  test("decode back to well-formed SVG markup", () => {
    [FALLBACK_POSTER, FALLBACK_BACKGROUND].forEach((uri) => {
      const svg = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
    });
  });

  test("poster and background are different images", () => {
    expect(FALLBACK_POSTER).not.toBe(FALLBACK_BACKGROUND);
  });

  test("stay small enough to embed in every item of a catalog page", () => {
    expect(FALLBACK_POSTER.length).toBeLessThan(4096);
    expect(FALLBACK_BACKGROUND.length).toBeLessThan(4096);
  });
});
