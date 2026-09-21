const path = require("path");
const { Readable } = require("stream");
const express = require("express");
const { decodeConfig } = require("./src/config");
const { withBaseUrl } = require("./src/requestContext");
const { resolveVideo, buildDashManifest, ANDROID_CLIENT, VIDEO_ID_RE } = require("./src/youtubeStream");
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
 * Playing a YouTube story.
 *
 * Three routes, one idea: the bytes are proxied rather than redirected to.
 * That is forced rather than chosen -- the media URLs YouTube hands back are
 * signed over the IP that asked for them (`ip` appears in each URL's own
 * `sparams` list), so a URL resolved here and handed to a television is
 * refused on arrival. Fetching from the same host that resolved is the only
 * arrangement that works.
 *
 *   /yt/<id>/manifest.mpd  the DASH manifest, where the quality lives
 *   /yt/<id>/<itag>        one adaptive format, ranged
 *   /yt/<id>.mp4           the muxed 360p file, for a player without DASH
 */
function resolveFailed(res, videoId, err) {
  console.error(`[yt] ${videoId}: ${err.message}`);
  const status = err.status >= 400 && err.status < 600 ? err.status : 502;
  return res.status(status).json({ error: err.message });
}

/** Pipe an upstream media response through, Range headers intact. */
async function pipeMedia(req, res, mediaUrl, fallbackType) {
  const headers = { "User-Agent": ANDROID_CLIENT.userAgent };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(mediaUrl, { method: req.method === "HEAD" ? "HEAD" : "GET", headers });
  } catch (err) {
    console.error(`[yt] media fetch failed: ${err.message}`);
    return res.status(502).json({ error: "Could not reach the video." });
  }

  res.status(upstream.status);
  res.set("Content-Type", upstream.headers.get("content-type") || fallbackType);
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

/** The DASH manifest: separate video and audio, so 1080p is reachable. */
async function playManifest(req, res) {
  const { videoId } = req.params;
  if (!VIDEO_ID_RE.test(videoId)) return res.status(400).json({ error: "Not a YouTube video id." });

  let video;
  try {
    video = await resolveVideo(videoId);
  } catch (err) {
    return resolveFailed(res, videoId, err);
  }

  const manifest = buildDashManifest({
    video: video.adaptive.video,
    audio: video.adaptive.audio,
    durationSeconds: video.durationSeconds,
    baseUrl: `${getBaseUrl(req)}/yt/${videoId}`
  });

  res.set("Content-Type", "application/dash+xml");
  res.set("Cache-Control", "public, max-age=900");
  return res.send(manifest);
}

/** One adaptive format, addressed by the itag the manifest names. */
async function playFormat(req, res) {
  const { videoId, itag } = req.params;
  if (!VIDEO_ID_RE.test(videoId)) return res.status(400).json({ error: "Not a YouTube video id." });

  let video;
  try {
    video = await resolveVideo(videoId);
  } catch (err) {
    return resolveFailed(res, videoId, err);
  }

  const format = video.byItag.get(String(itag));
  if (!format) return res.status(404).json({ error: "No such format for this video." });
  return pipeMedia(req, res, format.url, format.mimeType);
}

/** The muxed 360p file, kept for players that cannot read a manifest. */
async function playProgressive(req, res) {
  const { videoId } = req.params;
  if (!VIDEO_ID_RE.test(videoId)) return res.status(400).json({ error: "Not a YouTube video id." });

  let video;
  try {
    video = await resolveVideo(videoId);
  } catch (err) {
    return resolveFailed(res, videoId, err);
  }

  if (!video.progressive) return res.status(415).json({ error: "No single-file format for this video." });
  return pipeMedia(req, res, video.progressive.url, video.progressive.mimeType);
}

app.get("/yt/:videoId/manifest.mpd", playManifest);
app.get("/yt/:videoId.mp4", playProgressive);
app.head("/yt/:videoId.mp4", playProgressive);
app.get("/yt/:videoId/:itag", playFormat);
app.head("/yt/:videoId/:itag", playFormat);

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

module.exports = { app, getBaseUrl, playManifest, playFormat, playProgressive };

/* istanbul ignore next -- exercised for real by test/startup.test.js, which
   boots this file as a child process; coverage instrumentation does not span
   process boundaries, so it cannot observe this branch being taken. */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Newsio addon listening on port ${PORT}`);
  });
}
