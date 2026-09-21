const health = require("../src/youtubeHealth");

beforeEach(() => health.resetHealth());

const err = (message, status) => Object.assign(new Error(message), { status });

describe("telling an outage from a bad video", () => {
  test.each([
    ["Sign in to confirm you're not a bot", 403],
    ["LOGIN REQUIRED", 403],
    ["Could not reach YouTube: ENOTFOUND", 502],
    ["Too many requests", 429]
  ])("%p is an outage", (message, status) => {
    expect(health.isPlaybackOutage(err(message, status))).toBe(true);
  });

  test.each([
    ["YouTube will not serve this video: Private video", 403],
    ["YouTube will not serve this video: Video unavailable in your country", 403],
    ["No playable format available for this video", 415],
    ["Not a YouTube video id", 400]
  ])("%p is about that one video, not about us", (message, status) => {
    // These must not bury in-app playback for every other story.
    expect(health.isPlaybackOutage(err(message, status))).toBe(false);
  });

  test("nothing at all is not an outage", () => {
    expect(health.isPlaybackOutage(null)).toBe(false);
    expect(health.isPlaybackOutage(undefined)).toBe(false);
    expect(health.isPlaybackOutage({})).toBe(false);
  });
});

describe("the health record", () => {
  test("starts optimistic, so a fresh boot offers playback normally", () => {
    expect(health.isPlaybackHealthy()).toBe(true);
  });

  test("an outage demotes it", () => {
    health.recordFailure(err("Sign in to confirm you're not a bot", 403));
    expect(health.isPlaybackHealthy()).toBe(false);
  });

  test("a single bad video does not", () => {
    health.recordFailure(err("YouTube will not serve this video: Private video", 403));
    expect(health.isPlaybackHealthy()).toBe(true);
  });

  test("a success clears it again, so it self-heals the moment it works", () => {
    health.recordFailure(err("Sign in to confirm you're not a bot", 403));
    expect(health.isPlaybackHealthy()).toBe(false);
    health.recordSuccess();
    expect(health.isPlaybackHealthy()).toBe(true);
  });

  test("the memory is short, so a cleared block is not remembered forever", () => {
    expect(health.HEALTH_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});
