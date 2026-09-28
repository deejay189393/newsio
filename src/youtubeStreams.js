/**
 * Which ways of watching a YouTube story are offered, and in what order.
 *
 * Three options, each independently on or off, and the order they are listed
 * here is the order Nuvio shows them. The first one is what the play button
 * lands on, which is the whole point of making it configurable: in-app
 * playback depends on YouTube being willing to serve this server, and when
 * it is not, a viewer wants the row that works sitting at the top.
 *
 * What the addon can and cannot promise about the two external options is
 * worth stating plainly, because it shaped the design:
 *
 * Nuvio opens an external stream with
 *
 *     Intent(Intent.ACTION_VIEW, Uri.parse(externalUrl))
 *         .addCategory(Intent.CATEGORY_BROWSABLE)
 *
 * -- `Uri.parse`, not `Intent.parseUri`, and no `setPackage` anywhere in the
 * app. So Android's `intent://...#Intent;package=...;end` form, which is the
 * one way to name a target application, is parsed as a URI with the scheme
 * "intent", matches nothing, and silently does nothing. The addon cannot
 * name an app; it can only choose a URI and let Android route it.
 *
 * SmartTube registers no scheme of its own either: its manifest claims
 * http/https on the YouTube hosts plus `vnd.youtube` and
 * `vnd.youtube.launch`, every one of which the official YouTube app also
 * claims. So the difference between the two external options is real but
 * narrower than their names suggest:
 *
 *   - the YouTube option sends a plain https watch URL, which a browser can
 *     also handle, so on a device with a browser that is a possible target;
 *   - the SmartTube option sends `vnd.youtube:<id>`, which no browser
 *     handles, so it can only land in a YouTube *application* -- which on a
 *     television running SmartTube is normally SmartTube, since the official
 *     app is usually absent or SmartTube is set as the default handler.
 *
 * It is a preference, not a guarantee, and the labels say "app" rather than
 * claiming the video will definitely open in one named program.
 */

const WATCH_URL = "https://www.youtube.com/watch?v=";

/**
 * Every option, in the order the configure page lists them before the user
 * rearranges anything.
 */
const YOUTUBE_STREAM_OPTIONS = [
  {
    id: "app",
    label: "Play in-app",
    note: "Streams through Newsio at the best quality YouTube offers."
  },
  {
    id: "youtube",
    label: "Open in the YouTube app",
    note: "Hands the video to whichever app handles youtube.com links."
  },
  {
    id: "smarttube",
    label: "Open in the SmartTube app",
    note: "Sends vnd.youtube:, which only a YouTube app can open, never a browser."
  },
  {
    id: "ytid",
    label: "Play in-app, direct from YouTube",
    note:
      "Sends only the YouTube id, and your app fetches the video itself, so YouTube refusing Newsio's server does not matter. Stremio plays it in its built-in YouTube player; Nuvio needs a release newer than 1.1.0-beta.2, and older ones list it but cannot play it."
  }
];

const OPTION_IDS = YOUTUBE_STREAM_OPTIONS.map((o) => o.id);
const OPTIONS_BY_ID = new Map(YOUTUBE_STREAM_OPTIONS.map((o) => [o.id, o]));

/**
 * What a config with nothing saved gets.
 *
 * In-app first, the YouTube app behind it. SmartTube is off rather than on,
 * because it is a separately installed application and an option that opens
 * nothing is exactly the dead row this addon has been removing.
 *
 * Direct-from-YouTube (a bare `ytId`) comes last. It is the one way to watch
 * that does not depend on YouTube tolerating this server, because the app
 * fetches the video itself -- Stremio in its built-in player, Nuvio through
 * the extractor its trailers use. Nuvio only learned it after 1.1.0-beta.2,
 * so for now it sits at the bottom, where an older Nuvio that cannot play it
 * costs nothing; once that release is out it can move up.
 */
const DEFAULT_YOUTUBE_STREAMS = ["app", "youtube", "ytid"];

/**
 * The version of the option list a config was saved against.
 *
 * A saved list is an explicit choice, so an option missing from it is off.
 * But a list saved before an option existed never had the chance to include
 * it, and reading that as "turned off" would keep a new option away from
 * everyone who installed earlier. So new configs record the version they
 * were saved at, and a list saved at an older one gains, at the bottom,
 * every option added since.
 *
 *   1 (unrecorded)  app, youtube, smarttube
 *   2               + ytid
 */
const YOUTUBE_STREAMS_VERSION = 2;
const ADDED_SINCE_VERSION_1 = ["ytid"];

/**
 * The older single-choice setting, mapped onto the list it now means.
 *
 * An installed addon carries `youtubePlayback` in its URL, and re-encoding
 * it as a list has to leave the user watching what they were watching
 * before rather than silently reordering their play button.
 */
const LEGACY_PLAYBACK_ORDER = {
  app: ["app", "youtube"],
  youtube: ["youtube", "app"]
};

/**
 * An ordered, de-duplicated list of known option ids.
 *
 * An empty result falls back to the default rather than leaving a YouTube
 * story with no way at all to watch it: a config that turns everything off
 * is a config that cannot play anything, which is never what was meant.
 */
function normalizeYoutubeStreams(value, legacy, version) {
  const savedBeforeCurrent = !(Number(version) >= YOUTUBE_STREAMS_VERSION);
  const withNewOptions = (list) =>
    savedBeforeCurrent ? [...list, ...ADDED_SINCE_VERSION_1.filter((id) => !list.includes(id))] : list;

  if (!Array.isArray(value)) {
    const migrated = LEGACY_PLAYBACK_ORDER[legacy];
    return migrated ? withNewOptions([...migrated]) : [...DEFAULT_YOUTUBE_STREAMS];
  }

  const seen = new Set();
  const ordered = [];
  value.forEach((id) => {
    if (typeof id !== "string" || !OPTIONS_BY_ID.has(id) || seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  });

  return ordered.length ? withNewOptions(ordered) : [...DEFAULT_YOUTUBE_STREAMS];
}

/**
 * A config's options, in order: the one place a raw config -- as the SDK
 * hands it over, or decoded from an install URL -- is read for them, so the
 * legacy single choice and the saved version are never forgotten on the way.
 */
function youtubeStreamsOf(config) {
  return normalizeYoutubeStreams(
    config && config.youtubeStreams,
    config && config.youtubePlayback,
    config && config.youtubeStreamsVersion
  );
}

/** The option list a configure page renders: enabled ones first, in order. */
function orderedYoutubeOptions(enabled) {
  const chosen = normalizeYoutubeStreams(enabled, undefined, YOUTUBE_STREAMS_VERSION);
  const rest = OPTION_IDS.filter((id) => !chosen.includes(id));
  return [...chosen, ...rest].map((id) => ({ ...OPTIONS_BY_ID.get(id), enabled: chosen.includes(id) }));
}

/** The external URI each option hands to Android, or null for the two in-app ones. */
function externalUrlFor(optionId, videoId) {
  if (optionId === "youtube") return `${WATCH_URL}${videoId}`;
  // No browser registers this scheme, so it can only reach a YouTube app.
  if (optionId === "smarttube") return `vnd.youtube:${videoId}`;
  return null;
}

module.exports = {
  YOUTUBE_STREAM_OPTIONS,
  OPTION_IDS,
  DEFAULT_YOUTUBE_STREAMS,
  YOUTUBE_STREAMS_VERSION,
  LEGACY_PLAYBACK_ORDER,
  normalizeYoutubeStreams,
  youtubeStreamsOf,
  orderedYoutubeOptions,
  externalUrlFor,
  WATCH_URL
};
