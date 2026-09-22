/**
 * Byte-range arithmetic for the media proxy.
 *
 * A client may ask for the last N bytes of a file with a suffix range --
 * `Range: bytes=-2000`, meaning "the final 2000 bytes", with no start
 * offset. It is the normal way a player finds an MP4's `moov` atom when
 * that atom sits at the end of the file, and it is how several seek
 * implementations probe before scrubbing.
 *
 * googlevideo does not accept that form. Measured against a live format:
 * `bytes=1000-2000` returns 206 with a proper Content-Range, while
 * `bytes=-2000` on the same URL returns 416 Range Not Satisfiable. Passing
 * the client's header straight through therefore turned every one of those
 * probes into a failure, and a player that cannot read the end of a file
 * cannot build a seek index -- which is why scrubbing did nothing.
 *
 * We know each format's exact length from the player response, so the
 * suffix form can be rewritten into the absolute one upstream does accept.
 * Nothing else about the header is touched: a range upstream handles is
 * forwarded exactly as the client wrote it.
 */

/** `bytes=-123`, and nothing else. A start offset disqualifies it. */
const SUFFIX_RANGE = /^bytes=-(\d+)$/i;

/**
 * Rewrite a suffix range into an absolute one.
 *
 * Returns the header unchanged when it is already absolute, when it asks
 * for several ranges at once, or when the length is unknown and the
 * arithmetic cannot be done -- in those cases upstream is still the right
 * place to decide.
 */
function normalizeRange(range, contentLength) {
  if (typeof range !== "string" || !range) return range;

  const match = SUFFIX_RANGE.exec(range.trim());
  if (!match) return range;

  const suffixLength = Number(match[1]);
  const total = Number(contentLength);
  if (!Number.isFinite(total) || total <= 0) return range;
  // "The last zero bytes" is unsatisfiable by the spec; let upstream say so
  // rather than inventing a range that means something else.
  if (!Number.isFinite(suffixLength) || suffixLength <= 0) return range;

  // Asking for more than exists means the whole file, per RFC 9110.
  const start = suffixLength >= total ? 0 : total - suffixLength;
  return `bytes=${start}-${total - 1}`;
}

module.exports = { normalizeRange, SUFFIX_RANGE };
