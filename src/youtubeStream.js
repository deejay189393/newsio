/**
 * Resolving a YouTube video id to something Nuvio's player can open.
 *
 * Why this exists: the addon protocol has a `ytId` field, and the manifest
 * says it "plays using the built-in YouTube player". Nuvio parses it -- its
 * Stream model has the field and even an `isYouTube()` helper -- but nothing
 * acts on it. `getStreamUrl()` reads `url` and `externalUrl` only, and the
 * player path never special-cases a YouTube URL anywhere. Nuvio *can* play
 * YouTube, but only through `InAppYouTubeExtractor`, which is wired into
 * `TrailerService` alone and which no addon stream can reach. So there is no
 * stream shape that makes the app resolve a video id by itself; the addon has
 * to hand over real media.
 *
 * Two shapes come out of here, and the difference is the whole quality story:
 *
 *   - a *progressive* file (itag 18, H.264 360p, audio muxed in). One URL,
 *     plays anywhere, and 360p is the ceiling -- it is the only muxed format
 *     YouTube still publishes.
 *
 *   - a *DASH manifest* we generate, listing the adaptive formats. Adaptive
 *     means video and audio arrive as separate files, which one stream URL
 *     cannot express -- but a manifest can, and that is where 1080p lives.
 *     Every field the manifest needs (initRange, indexRange, codecs,
 *     dimensions) is in the player response already.
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
 * The client whose player response still carries a muxed format, and whose
 * URLs arrive unciphered. Its version string is part of what YouTube matches
 * on, so it is kept together with the user agent rather than scattered.
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

/**
 * The shortest gap between two scrapes of the watch page.
 *
 * A refusal used to drop the cached config unconditionally, so the next
 * attempt fetched a fresh watch page. Under a sustained block that means
 * every single press of play fetches a full HTML page from the endpoint
 * that is already answering 429 -- the failure path generating more load
 * against the thing rate-limiting us, which both prolongs the block and is
 * simply rude. Re-scraping is still how a genuinely stale visitor id gets
 * replaced; it just cannot happen more often than this.
 */
const RESCRAPE_FLOOR_MS = 5 * 60 * 1000;

/**
 * H.264 video and AAC audio only.
 *
 * YouTube also offers VP9 and AV1 at the same resolutions, often at a lower
 * bitrate, but television decoders are far less consistent about them and a
 * format the TV cannot decode in hardware is worse than one a notch smaller.
 * H.264 plus AAC is the pairing every Android TV decodes.
 */
const VIDEO_CODEC_RE = /^avc1/;
const AUDIO_CODEC_RE = /^mp4a/;

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * The InnerTube key and visitor id, scraped from a watch page.
 *
 * Cached, because it is per-session rather than per-video: fetching a full
 * HTML page before every playback would double the latency of pressing play
 * for no benefit.
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
  const config = { apiKey, visitorData, fetchedAt: Date.now() };
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

/**
 * Should a refusal cause the watch page to be scraped again?
 *
 * Only for the statuses a new visitor id could plausibly fix, and only
 * once the current one is older than the floor.
 */
function staleEnoughToRescrape(config, status) {
  if (status !== "LOGIN_REQUIRED" && status !== "UNPLAYABLE") return false;
  const age = Date.now() - ((config && config.fetchedAt) || 0);
  return age >= RESCRAPE_FLOOR_MS;
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

const codecsOf = (mimeType) => {
  const match = /codecs="([^"]+)"/.exec(mimeType || "");
  return match ? match[1] : "";
};

/**
 * Pick the muxed format: one file carrying both picture and sound.
 *
 * A format carrying `signatureCipher` instead of `url` needs JavaScript from
 * the page deciphered to unlock it, which is not worth doing when the Android
 * client hands over a plain URL.
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

/**
 * The adaptive formats worth putting in a manifest: an H.264 ladder the
 * player can move up and down, and the single best AAC track.
 *
 * Only formats carrying every byte range the manifest needs are kept -- a
 * Representation without its index and initialisation ranges is one the
 * player cannot start.
 */
function pickAdaptive(playerResponse) {
  const streaming = (playerResponse && playerResponse.streamingData) || {};
  const all = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];

  // Height and bitrate are normalised here, once, so that everything
  // downstream -- the sorts and the manifest alike -- can treat them as
  // plain numbers rather than repeating the same guard at each use.
  const usable = all
    .filter((f) => f && typeof f.url === "string" && f.initRange && f.indexRange && f.contentLength)
    .map((f) => ({ ...f, height: Number(f.height) || 0, bitrate: Number(f.bitrate) || 0 }));

  const video = usable
    .filter((f) => (f.mimeType || "").startsWith("video/") && VIDEO_CODEC_RE.test(codecsOf(f.mimeType)))
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);

  // One representation per resolution; YouTube lists several encodes of the
  // same height and a manifest offering duplicates just confuses the picker.
  const byHeight = new Map();
  video.forEach((f) => {
    if (!byHeight.has(f.height)) byHeight.set(f.height, f);
  });

  const audio = usable
    .filter((f) => (f.mimeType || "").startsWith("audio/") && AUDIO_CODEC_RE.test(codecsOf(f.mimeType)))
    .sort((a, b) => b.bitrate - a.bitrate)[0];

  return { video: [...byHeight.values()], audio: audio || null };
}

/** Seconds as an ISO 8601 duration, which is what MPD durations are. */
const isoDuration = (seconds) => `PT${Math.max(0, Number(seconds) || 0).toFixed(3)}S`;

const xmlEscape = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function representation(format, baseUrl, extra, inner = "") {
  return [
    `      <Representation id="${format.itag}" codecs="${xmlEscape(codecsOf(format.mimeType))}"`,
    ` bandwidth="${Math.round(format.bitrate) || 0}"${extra} startWithSAP="1">`,
    inner,
    `\n        <BaseURL>${xmlEscape(`${baseUrl}/${format.itag}`)}</BaseURL>`,
    `\n        <SegmentBase indexRange="${format.indexRange.start}-${format.indexRange.end}">`,
    `\n          <Initialization range="${format.initRange.start}-${format.initRange.end}"/>`,
    `\n        </SegmentBase>`,
    `\n      </Representation>`
  ].join("");
}

/**
 * A DASH manifest over the adaptive formats.
 *
 * `SegmentBase` with explicit byte ranges is the on-demand DASH profile: the
 * player reads the initialisation segment and the index, then issues ranged
 * requests for the rest. Every one of those goes to our own proxy, because
 * the underlying URLs are IP-locked to whoever resolved them.
 */
function buildDashManifest({ video, audio, durationSeconds, baseUrl }) {
  const sets = [];

  if (video.length) {
    sets.push(
      [
        '    <AdaptationSet contentType="video" mimeType="video/mp4" subsegmentAlignment="true"',
        ' subsegmentStartsWithSAP="1">\n',
        video
          .map((f) =>
            representation(
              f,
              baseUrl,
              ` width="${f.width}" height="${f.height}" frameRate="${Math.round(f.fps || 30)}"`
            )
          )
          .join("\n"),
        "\n    </AdaptationSet>"
      ].join("")
    );
  }

  if (audio) {
    sets.push(
      [
        '    <AdaptationSet contentType="audio" mimeType="audio/mp4" subsegmentAlignment="true"',
        ' subsegmentStartsWithSAP="1" lang="und">\n',
        representation(
          audio,
          baseUrl,
          ` audioSamplingRate="${audio.audioSampleRate || 44100}"`,
          '\n        <AudioChannelConfiguration' +
            ' schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>'
        ),
        "\n    </AdaptationSet>"
      ].join("")
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"',
    ` type="static" mediaPresentationDuration="${isoDuration(durationSeconds)}" minBufferTime="PT1.5S">`,
    "\n  <Period>\n",
    sets.join("\n"),
    "\n  </Period>\n</MPD>\n"
  ].join("");
}

const cacheKey = (videoId) => `youtube::media::${videoId}`;

/**
 * Everything needed to play one video: the muxed fallback, the adaptive
 * ladder, and how long the whole thing runs.
 *
 * Cached until shortly before the URLs' own expiry, so pressing play on the
 * same story twice does not re-scrape anything.
 */
async function resolveVideo(videoId, { fetchImpl = fetch } = {}) {
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
    // than anything about the video, so a fresh visitor id is worth trying --
    // but only if the one we hold has had a fair run. Dropping it on every
    // refusal turns a sustained block into a watch-page fetch per press of
    // play, against the endpoint already answering 429.
    if (staleEnoughToRescrape(config, status)) catalogCache.delete(WATCH_CONFIG_KEY);
    throw fail(`YouTube will not serve this video: ${reason}`, 403);
  }

  const progressive = pickProgressive(player);
  const adaptive = pickAdaptive(player);
  if (!progressive && !adaptive.video.length) {
    throw fail("No playable format available for this video", 415);
  }

  const details = player.videoDetails || {};
  const byItag = new Map();
  [...adaptive.video, ...(adaptive.audio ? [adaptive.audio] : []), ...(progressive ? [progressive] : [])].forEach(
    (f) =>
      byItag.set(String(f.itag), {
        url: f.url,
        mimeType: f.mimeType.split(";")[0],
        // Needed to rewrite a suffix range, which googlevideo refuses.
        contentLength: Number(f.contentLength) || null
      })
  );

  const resolved = {
    progressive: progressive
      ? {
          itag: progressive.itag,
          url: progressive.url,
          mimeType: progressive.mimeType.split(";")[0],
          contentLength: Number(progressive.contentLength) || null,
          quality: progressive.qualityLabel || null
        }
      : null,
    adaptive,
    byItag,
    durationSeconds: Number(details.lengthSeconds) || 0,
    // What the manifest will actually offer, for the stream's label.
    bestQuality: adaptive.video.length
      ? adaptive.video[0].qualityLabel || `${adaptive.video[0].height}p`
      : progressive && progressive.qualityLabel
  };

  const anyUrl = (adaptive.video[0] || progressive).url;
  const expires = expiryOf(anyUrl);
  const ttl = expires ? expires - Date.now() - EXPIRY_MARGIN_MS : 0;
  if (ttl > 0) catalogCache.set(cacheKey(videoId), resolved, ttl);
  return resolved;
}

module.exports = {
  resolveVideo,
  getWatchConfig,
  fetchPlayerResponse,
  pickProgressive,
  pickAdaptive,
  buildDashManifest,
  expiryOf,
  staleEnoughToRescrape,
  codecsOf,
  isoDuration,
  ANDROID_CLIENT,
  VIDEO_ID_RE,
  WATCH_CONFIG_KEY,
  EXPIRY_MARGIN_MS,
  RESCRAPE_FLOOR_MS
};
