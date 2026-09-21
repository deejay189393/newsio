/**
 * Resolving a YouTube video id to a media URL the player can open.
 *
 * Why this exists at all: the addon protocol has a `ytId` field, and the
 * manifest says it "plays using the built-in YouTube player". Nuvio parses
 * it -- its Stream model has the field and even an `isYouTube()` helper --
 * but nothing acts on it. Its `getStreamUrl()` reads `url` and
 * `externalUrl` only, so a `ytId` stream resolves to nothing and tapping it
 * does nothing at all. Nuvio *can* play YouTube (its trailers do), but that
 * runs through a separate in-app extractor the addon stream path never
 * reaches. So the addon has to hand over a real media URL.
 *
 * The approach mirrors that same in-app extractor: ask YouTube's InnerTube
 * player endpoint, pretending to be a first-party client. The Android
 * client is the one that matters here, because it is the only one that
 * still returns a *progressive* format -- itag 18, H.264 360p with the
 * audio muxed in. Every higher quality YouTube offers is adaptive: video
 * and audio as separate files, which a single stream URL cannot express.
 *
 * The watch page is fetched first for its InnerTube API key and visitor id.
 * Skipping that works for a while and then starts coming back
 * LOGIN_REQUIRED, which is YouTube declining to serve an unidentified
 * caller -- measured here, from a datacenter IP, within minutes.
 */

const { catalogCache } = require("./cache");

const WATCH_URL = "https://www.youtube.com/watch?v=";
const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";

const API_KEY_RE = /"INNERTUBE_API_KEY":"([^"]+)"/;
const VISITOR_DATA_RE = /"VISITOR_DATA":"([^"]+)"/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * The client whose player response still carries a muxed format. Its
 * version string is part of what YouTube matches on, so it is kept
 * together with the user agent rather than scattered.
 */
const ANDROID_CLIENT = {
  name: "ANDROID",
  id: "3",
  version: "20.10.35",
  userAgent: "com.google.android.youtube/20.10.35 (Linux; U; Android 14; en_US) gzip",
  context: {
    clientName: "ANDROID",
    clientVersion: "20.10.35",
    osName: "Android",
    osVersion: "14",
    platform: "MOBILE",
    androidSdkVersion: 34,
    hl: "en"
  }
};

const WATCH_CONFIG_KEY = "youtube::watch-config";
const WATCH_CONFIG_TTL_MS = 30 * 60 * 1000;

/** How long before a URL's own expiry we stop handing it out. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * The InnerTube key and visitor id, scraped from a watch page.
 *
 * Cached, because it is per-session rather than per-video: fetching a full
 * HTML page before every playback would double the latency of pressing
 * play for no benefit.
 */
async function getWatchConfig(fetchImpl) {
  const cached = catalogCache.get(WATCH_CONFIG_KEY);
  if (cached) return cached;

  let response;
  try {
    response = await fetchImpl(`${WATCH_URL}dQw4w9WgXcQ`, {
      headers: { "User-Agent": ANDROID_CLIENT.userAgent, "Accept-Language": "en-US,en;q=0.9" }
    });
  } catch (err) {
    throw fail(`Could not reach YouTube: ${err.message}`, 502);
  }
  if (!response.ok) throw fail(`YouTube watch page returned HTTP ${response.status}`, response.status);

  const html = await response.text();
  const apiKey = (API_KEY_RE.exec(html) || [])[1] || null;
  const visitorData = (VISITOR_DATA_RE.exec(html) || [])[1] || null;
  const config = { apiKey, visitorData };
  catalogCache.set(WATCH_CONFIG_KEY, config, WATCH_CONFIG_TTL_MS);
  return config;
}

/** Ask InnerTube for a video's streaming data. */
async function fetchPlayerResponse(videoId, config, fetchImpl) {
  const url = config.apiKey ? `${PLAYER_URL}?key=${encodeURIComponent(config.apiKey)}` : PLAYER_URL;
  const headers = {
    "Content-Type": "application/json",
    Origin: "https://www.youtube.com",
    "User-Agent": ANDROID_CLIENT.userAgent,
    "X-YouTube-Client-Name": ANDROID_CLIENT.id,
    "X-YouTube-Client-Version": ANDROID_CLIENT.version
  };
  if (config.visitorData) headers["X-Goog-Visitor-Id"] = config.visitorData;

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: { client: ANDROID_CLIENT.context },
        playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } }
      })
    });
  } catch (err) {
    throw fail(`Could not reach YouTube: ${err.message}`, 502);
  }

  if (!response.ok) throw fail(`YouTube player API returned HTTP ${response.status}`, response.status);
  return response.json();
}

/** When does this media URL stop working? Its own `expire` param says. */
function expiryOf(mediaUrl) {
  try {
    const seconds = Number(new URL(mediaUrl).searchParams.get("expire"));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch (_) {
    return null;
  }
}

/**
 * Pick the muxed format.
 *
 * `streamingData.formats` is the progressive list; `adaptiveFormats` is
 * deliberately ignored, since an adaptive entry is video *or* audio and
 * handing the player one of those gives a silent picture or a black screen
 * with sound. A format carrying `signatureCipher` instead of `url` needs
 * JavaScript from the page deciphered to unlock it, which is not worth
 * doing when the Android client hands over a plain URL.
 */
function pickProgressive(playerResponse) {
  const streaming = (playerResponse && playerResponse.streamingData) || {};
  const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
  return (
    formats
      .filter((f) => f && typeof f.url === "string" && (f.mimeType || "").startsWith("video/"))
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null
  );
}

const cacheKey = (videoId) => `youtube::media::${videoId}`;

/**
 * Resolve one video id to a playable media URL.
 *
 * The result is cached until shortly before the URL's own expiry, so
 * pressing play on the same story twice does not re-scrape anything.
 */
async function resolveMediaUrl(videoId, { fetchImpl = fetch } = {}) {
  if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)) {
    throw fail("Not a YouTube video id", 400);
  }

  const cached = catalogCache.get(cacheKey(videoId));
  if (cached) return cached;

  const config = await getWatchConfig(fetchImpl);
  const player = await fetchPlayerResponse(videoId, config, fetchImpl);

  const status = (player && player.playabilityStatus && player.playabilityStatus.status) || "UNKNOWN";
  if (status !== "OK") {
    const reason = (player.playabilityStatus && player.playabilityStatus.reason) || status;
    // LOGIN_REQUIRED here is YouTube declining to serve this caller rather
    // than anything about the video, so the cached config is dropped: the
    // next attempt scrapes a fresh visitor id instead of reusing a spent one.
    if (status === "LOGIN_REQUIRED" || status === "UNPLAYABLE") catalogCache.delete(WATCH_CONFIG_KEY);
    throw fail(`YouTube will not serve this video: ${reason}`, 403);
  }

  const format = pickProgressive(player);
  if (!format) throw fail("No single-file format available for this video", 415);

  const resolved = {
    url: format.url,
    // Guaranteed present and video/* by pickProgressive; codecs stripped.
    mimeType: format.mimeType.split(";")[0],
    contentLength: Number(format.contentLength) || null,
    quality: format.qualityLabel || null,
    itag: format.itag
  };

  const expires = expiryOf(format.url);
  const ttl = expires ? expires - Date.now() - EXPIRY_MARGIN_MS : 0;
  if (ttl > 0) catalogCache.set(cacheKey(videoId), resolved, ttl);
  return resolved;
}

module.exports = {
  resolveMediaUrl,
  getWatchConfig,
  fetchPlayerResponse,
  pickProgressive,
  expiryOf,
  ANDROID_CLIENT,
  VIDEO_ID_RE,
  WATCH_CONFIG_KEY,
  EXPIRY_MARGIN_MS
};
