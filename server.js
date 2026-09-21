const path = require("path");
const { Readable } = require("stream");
const express = require("express");
const { decodeConfig } = require("./src/config");
const { withBaseUrl } = require("./src/requestContext");
const { resolveMediaUrl, ANDROID_CLIENT, VIDEO_ID_RE } = require("./src/youtubeStream");
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

// Every handler below can ask what host it is answering on, which the
// stream handler needs and the SDK does not pass through.
app.use((req, res, next) => withBaseUrl(getBaseUrl(req), next));

app.use(express.static(path.join(__dirname, "public")));

/**
 * Play a YouTube story.
 *
 * The bytes are proxied rather than redirected to, and that is forced
 * rather than chosen: the media URL YouTube hands back is signed over the
 * IP that asked for it (`ip` appears in its own `sparams` list), so a URL
 * resolved here and handed to a television 403s on arrival. Fetching it
 * from the same host that resolved it is the only arrangement that works.
 *
 * Range requests are passed straight through in both directions, which is
 * what lets the viewer scrub. The cost is bandwidth: these are 360p news
 * clips, so tens of megabytes, not gigabytes.
 */
async function playYouTube(req, res) {
  const videoId = req.params.videoId;
  if (!VIDEO_ID_RE.test(videoId)) return res.status(400).json({ error: "Not a YouTube video id." });

  let media;
  try {
    media = await resolveMediaUrl(videoId);
  } catch (err) {
    console.error(`[yt] ${videoId}: ${err.message}`);
    return res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 502).json({
      error: err.message
    });
  }

  const headers = { "User-Agent": ANDROID_CLIENT.userAgent };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(media.url, { method: req.method === "HEAD" ? "HEAD" : "GET", headers });
  } catch (err) {
    console.error(`[yt] ${videoId} fetch failed: ${err.message}`);
    return res.status(502).json({ error: "Could not reach the video." });
  }

  res.status(upstream.status);
  res.set("Content-Type", upstream.headers.get("content-type") || media.mimeType);
  res.set("Accept-Ranges", "bytes");
  ["content-length", "content-range"].forEach((h) => {
    const value = upstream.headers.get(h);
    if (value) res.set(h, value);
  });

  if (req.method === "HEAD" || !upstream.body) return res.end();

  const body = Readable.fromWeb(upstream.body);
  // The viewer closing the player mid-stream aborts the response; stop
  // pulling from YouTube rather than filling a socket nobody is reading.
  res.on("close", () => body.destroy());
  body.on("error", () => res.destroy());
  return body.pipe(res);
}

app.get("/yt/:videoId.mp4", playYouTube);
app.head("/yt/:videoId.mp4", playYouTube);

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

module.exports = { app, getBaseUrl, playYouTube };

/* istanbul ignore next -- exercised for real by test/startup.test.js, which
   boots this file as a child process; coverage instrumentation does not span
   process boundaries, so it cannot observe this branch being taken. */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Newsio addon listening on port ${PORT}`);
  });
}
