const path = require("path");
const express = require("express");
const { decodeConfig } = require("./src/config");
const { buildManifest, getUnconfiguredManifest } = require("./src/manifest");
const { renderConfigurePage } = require("./src/configurePage");
const { createResourceRouter } = require("./src/addonInterface");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Behind Railway's proxy the request is TLS-terminated upstream, so
 * req.protocol reads "http". Trust the x-forwarded-proto header so the
 * manifest advertises https:// URLs (Stremio requires https for a
 * publicly installable addon).
 */
function getBaseUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto");
  const proto = forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol;
  return `${proto}://${req.get("host")}`;
}

function invalidConfig(res) {
  return res.status(400).json({ error: "Invalid or corrupted addon configuration." });
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/configure"));

app.get("/configure", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderConfigurePage({ baseUrl: getBaseUrl(req), existing: null }));
});

app.get("/health", (req, res) => res.json({ ok: true }));

// --- Manifest routes are served here rather than by the SDK router,
// because the catalog list must vary per user (only their selected
// topics) -- something the SDK's single static manifest cannot express.
// Registered before the SDK router below so they win for these paths.
app.get("/manifest.json", (req, res) => {
  res.json(getUnconfiguredManifest(getBaseUrl(req)));
});

app.get("/:config/manifest.json", (req, res) => {
  const decoded = decodeConfig(req.params.config);
  if (!decoded) return invalidConfig(res);
  res.json(buildManifest(decoded, getBaseUrl(req)));
});

// Re-configuration: Stremio's "Configure" button on an installed addon
// lands here, with the user's current settings in the path.
app.get("/:config/configure", (req, res) => {
  const decoded = decodeConfig(req.params.config);
  if (!decoded) return invalidConfig(res);
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderConfigurePage({ baseUrl: getBaseUrl(req), existing: decoded }));
});

// --- Catalog / meta / stream, handled by the real stremio-addon-sdk
// router: extra-parameter parsing (search/skip), config parsing, CORS and
// cache-control headers all per the official addon protocol.
app.use(createResourceRouter());

module.exports = { app, getBaseUrl };

/* istanbul ignore next -- exercised for real by test/startup.test.js, which
   boots this file as a child process; coverage instrumentation does not span
   process boundaries, so it cannot observe this branch being taken. */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Newsio addon listening on port ${PORT}`);
  });
}
