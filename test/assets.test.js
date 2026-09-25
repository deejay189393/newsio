/**
 * The addon's brand assets.
 *
 * These are real files on disk referenced by the manifest (logo/background),
 * by the configure page, and -- as inline data URIs -- by every catalog item
 * that has no image of its own. Nothing else in the suite would notice if one
 * were deleted, truncated, or swapped for a file of the wrong type, so they
 * are checked directly here.
 */
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { app } = require("../server");
const { FALLBACK_POSTER, FALLBACK_BACKGROUND } = require("../src/fallbackImages");

const PUBLIC = path.join(__dirname, "..", "public");
const read = (f) => fs.readFileSync(path.join(PUBLIC, f));

/** Width/height out of a PNG's IHDR chunk, which is always the first chunk. */
function pngSize(buf) {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("brand assets on disk", () => {
  test("every referenced asset exists", () => {
    ["logo.png", "logo.svg", "background.png", "background.svg"].forEach((f) => {
      expect(fs.existsSync(path.join(PUBLIC, f))).toBe(true);
    });
  });

  // The addon protocol is specific about these, and a client that enforces
  // it refuses the image and falls back to a generated letter avatar -- an
  // "N on purple" where the logo should be. The sizes are asserted exactly
  // rather than as minimums for that reason.
  test("logo.png is exactly 256x256, as the manifest spec requires", () => {
    expect(pngSize(read("logo.png"))).toEqual({ width: 256, height: 256 });
  });

  test("background.png meets the spec's minimum of 1024x786", () => {
    const { width, height } = pngSize(read("background.png"));
    expect(width).toBeGreaterThanOrEqual(1024);
    expect(height).toBeGreaterThanOrEqual(786);
  });

  test("background.png keeps a 16:9 backdrop shape", () => {
    const { width, height } = pngSize(read("background.png"));
    expect(width / height).toBeCloseTo(16 / 9, 2);
  });

  test("both are non-interlaced 8-bit PNGs, which every decoder accepts", () => {
    ["logo.png", "background.png"].forEach((f) => {
      const buf = read(f);
      expect(buf.readUInt8(24)).toBe(8); // bit depth
      expect(buf.readUInt8(28)).toBe(0); // interlace method: none
    });
  });

  test("the SVGs are well-formed and sized by a viewBox, so they scale", () => {
    ["logo.svg", "background.svg"].forEach((f) => {
      const svg = read(f).toString("utf8");
      expect(svg).toContain("<svg");
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
      expect(svg).toMatch(/viewBox="[\d\s.]+"/);
    });
  });
});

describe("the newspaper mark", () => {
  const logoSvg = read("logo.svg").toString("utf8");

  test("logo.svg draws shapes rather than relying on a font being installed", () => {
    // The previous logo was a text glyph, which renders differently (or not
    // at all) depending on the fonts available wherever it is rasterized.
    expect(logoSvg).not.toContain("<text");
    expect(logoSvg).not.toContain("font-family");
    expect(logoSvg).toMatch(/<(rect|path|ellipse)/);
  });

  test("keeps the brand purple", () => {
    expect(logoSvg.toLowerCase()).toContain("#6c5ce7");
  });

  test("background.svg is dark, so light article text stays readable over it", () => {
    expect(read("background.svg").toString("utf8").toLowerCase()).toContain("#0f1115");
  });
});

describe("inline fallback art", () => {
  test("is built from the SVGs on disk", () => {
    const decode = (uri) => Buffer.from(uri.split(",")[1], "base64").toString("utf8");
    expect(decode(FALLBACK_POSTER)).toBe(read("logo.svg").toString("utf8"));
    expect(decode(FALLBACK_BACKGROUND)).toBe(read("background.svg").toString("utf8"));
  });

  // These ride along in every meta object of every catalog page, so their
  // size is multiplied by the page size on every single catalog response.
  test("stays small enough to repeat across a whole catalog page", () => {
    expect(FALLBACK_POSTER.length).toBeLessThan(4096);
    expect(FALLBACK_BACKGROUND.length).toBeLessThan(4096);
  });
});

describe("assets are actually served", () => {
  test.each([
    ["/logo.png", "image/png"],
    ["/background.png", "image/png"],
    ["/logo.svg", "image/svg+xml"],
    ["/background.svg", "image/svg+xml"]
  ])("%s is served as %s", async (route, type) => {
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(type);
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
  });

  test("the manifest points at asset URLs that resolve", async () => {
    const manifest = (await request(app).get("/manifest.json")).body;
    for (const url of [manifest.logo, manifest.background]) {
      expect(url).toMatch(/^https?:\/\//);
      const { pathname, search } = new URL(url);
      expect((await request(app).get(pathname + search)).status).toBe(200);
    }
  });

  // Stremio clients cache addon artwork by URL, so replacing the bytes at a
  // fixed path leaves a stale image on screen indefinitely.
  test("asset URLs carry the addon version, so a new build busts the cache", async () => {
    const { ADDON_VERSION } = require("../src/manifest");
    const manifest = (await request(app).get("/manifest.json")).body;
    [manifest.logo, manifest.background].forEach((url) => {
      expect(new URL(url).searchParams.get("v")).toBe(ADDON_VERSION);
    });
  });

  test("a versioned asset URL still serves the file", async () => {
    const res = await request(app).get("/logo.png?v=0.14.0");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
  });

  test("the logo the manifest advertises is the same file the configure page shows", async () => {
    const manifest = (await request(app).get("/manifest.json")).body;
    const fromManifest = await request(app).get(new URL(manifest.logo).pathname);
    const page = await request(app).get("/configure");
    expect(page.text).toContain('<img src="/logo.png"');
    expect(Buffer.from(fromManifest.body)).toEqual(read("logo.png"));
  });
});
