/**
 * Which ways of watching a YouTube story are offered, and in what order.
 *
 * Three options, each independently on or off, and the order they are listed
 * here is the order the app shows them. The first one is what the play button
 * lands on.
 *
 * In-app playback sends the video's bare `ytId`, and the app fetches the
 * video itself: Stremio in its built-in YouTube player, Nuvio through the
 * extractor its trailers use (from the release after 1.1.0-beta.2). Nothing
 * passes through this server, so YouTube refusing its address -- which it
 * does, on and off -- no longer matters.
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
    label: "Play video in app",
    note:
      "Your app fetches the video straight from YouTube, at the best quality it offers. Stremio plays it in its built-in YouTube player; Nuvio needs a release newer than 1.1.0-beta.2."
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
  }
];

const OPTION_IDS = YOUTUBE_STREAM_OPTIONS.map((o) => o.id);
const OPTIONS_BY_ID = new Map(YOUTUBE_STREAM_OPTIONS.map((o) => [o.id, o]));

/**
 * What a config with nothing saved gets: in-app first, the YouTube app
 * behind it. SmartTube is off rather than on, because it is a separately
 * installed application and an option that opens nothing is exactly the dead
 * row this addon has been removing.
 */
const DEFAULT_YOUTUBE_STREAMS = ["app", "youtube"];

/**
 * The version of the option list a config was saved against.
 *
 * A saved list is an explicit choice, so an option missing from it is off.
 * But a list saved before an option existed never had the chance to include
 * it, and reading that as "turned off" would keep a new option away from
 * everyone who installed earlier. So configs record the version they were
 * saved at, and older lists are read in the terms they were saved in.
 *
 *   1 (unrecorded)  app (played through this server), youtube, smarttube
 *   2               + ytid (the bare YouTube id), added at the bottom of
 *                   every older list
 *   3               app *is* the bare YouTube id; ytid is folded into it
 */
const YOUTUBE_STREAMS_VERSION = 3;

/**
 * Options that no longer exist under their own name, and what they became.
 *
 * `ytid` was the bare-id option while `app` still played through this
 * server. Now `app` sends the bare id itself, so a saved `ytid` means `app`,
 * in the place it held -- and where a list had both, the first one keeps its
 * place, which is exactly the row that used to lead.
 */
const RENAMED_OPTIONS = { ytid: "app" };

/** What every list saved at version 1 was read as having at its bottom. */
const ADDED_AFTER_VERSION_1 = ["ytid"];

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
 * A list saved before version 2 is first given the option version 2 added,
 * so every config keeps the rows it was showing; then renamed options are
 * read as what they became. An empty result falls back to the default rather
 * than leaving a YouTube story with no way at all to watch it: a config that
 * turns everything off is a config that cannot play anything, which is never
 * what was meant.
 */
function normalizeYoutubeStreams(value, legacy, version) {
  const savedAtVersion1 = !(Number(version) >= 2);
  const withLaterOptions = (list) =>
    savedAtVersion1 ? [...list, ...ADDED_AFTER_VERSION_1.filter((id) => !list.includes(id))] : list;

  let saved;
  if (Array.isArray(value)) {
    saved = value;
  } else {
    const migrated = LEGACY_PLAYBACK_ORDER[legacy];
    if (!migrated) return [...DEFAULT_YOUTUBE_STREAMS];
    saved = migrated;
  }

  const seen = new Set();
  const ordered = [];
  withLaterOptions(saved).forEach((raw) => {
    if (typeof raw !== "string") return;
    const id = Object.hasOwn(RENAMED_OPTIONS, raw) ? RENAMED_OPTIONS[raw] : raw;
    if (!OPTIONS_BY_ID.has(id) || seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  });

  return ordered.length ? ordered : [...DEFAULT_YOUTUBE_STREAMS];
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

/** The external URI each option hands to Android, or null for in-app playback. */
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
  RENAMED_OPTIONS,
  normalizeYoutubeStreams,
  youtubeStreamsOf,
  orderedYoutubeOptions,
  externalUrlFor,
  WATCH_URL
};
