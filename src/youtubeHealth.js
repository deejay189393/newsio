/**
 * Whether in-app YouTube playback is currently working.
 *
 * It is not always working, and not for any reason this addon controls.
 * YouTube polices the IP a request comes from, and a host whose address it
 * has decided to distrust gets "Sign in to confirm you're not a bot" instead
 * of a video -- measured on Railway, on a deployment that had been playing
 * fine hours earlier, with no change to the code in between.
 *
 * When that happens the player asks for a manifest, receives an error, and
 * shows the viewer a failure. The viewer's actual intent -- watch this story
 * -- is perfectly servable: the YouTube app is right there and always works.
 * So the last outcome is remembered here, and the stream list puts the
 * working option first while playback is down.
 *
 * Deliberately a short memory. The block comes and goes, so a stale "broken"
 * would keep a working feature buried long after it recovered, and any
 * resolve -- success or failure -- corrects the record immediately.
 */

const { TTLCache } = require("./cache");

const HEALTH_KEY = "youtube::playback-healthy";

/** Long enough to cover a browsing session, short enough to self-heal. */
const HEALTH_TTL_MS = 10 * 60 * 1000;

const healthCache = new TTLCache(HEALTH_TTL_MS, 4);

/**
 * Which failures mean "playback is down" rather than "that one video is".
 *
 * A private or region-locked video is a fact about the video, and says
 * nothing about the next one, so it must not bury the in-app option for
 * everything else. Being refused as a suspected bot, or not reaching
 * YouTube at all, is about us.
 */
function isPlaybackOutage(err) {
  if (!err) return false;
  if (err.status === 502 || err.status === 429) return true;
  return /not a bot|sign in|login required|too many requests/i.test(err.message || "");
}

function recordSuccess() {
  healthCache.set(HEALTH_KEY, true);
}

function recordFailure(err) {
  if (isPlaybackOutage(err)) healthCache.set(HEALTH_KEY, false);
}

/**
 * True unless we have recently been refused.
 *
 * Optimistic by default: with nothing recorded, in-app playback is offered
 * as normal. Only evidence demotes it.
 */
function isPlaybackHealthy() {
  return healthCache.get(HEALTH_KEY) !== false;
}

function resetHealth() {
  healthCache.clear();
}

module.exports = {
  isPlaybackHealthy,
  isPlaybackOutage,
  recordSuccess,
  recordFailure,
  resetHealth,
  HEALTH_KEY,
  HEALTH_TTL_MS
};
