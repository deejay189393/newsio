const fs = require("fs");
const path = require("path");

/**
 * Inline data URIs for the poster/background used when an article has no
 * image of its own.
 *
 * These are computed once at module load from the SVG assets. They are
 * data URIs rather than absolute URLs because the SDK's catalog/meta
 * handlers never see the Express `req`, so there is no reliable "current
 * request host" to build an absolute URL from inside them -- and a
 * hardcoded host would break on a domain change. SVG keeps them small
 * enough (well under 1 KB) to embed in every item of a catalog page.
 */
function toDataUri(filename) {
  const svg = fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8");
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

const FALLBACK_POSTER = toDataUri("logo.svg");
const FALLBACK_BACKGROUND = toDataUri("background.svg");

module.exports = { FALLBACK_POSTER, FALLBACK_BACKGROUND };
