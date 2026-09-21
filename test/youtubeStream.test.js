const { clearAllCaches, catalogCache } = require("../src/cache");
const yt = require("../src/youtubeStream");

beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

const WATCH_HTML = 'x{"INNERTUBE_API_KEY":"AIzaTESTKEY","VISITOR_DATA":"CgtWSVNJVE9S"}y';

const html = (body) => ({ ok: true, status: 200, text: async () => body });
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

/** A media URL that expires well into the future. */
const mediaUrl = (id = "abc", expire = Math.floor(Date.now() / 1000) + 6 * 3600) =>
  `https://rr5---sn-x.googlevideo.com/videoplayback?expire=${expire}&itag=18&id=${id}`;

const playerOk = (over = {}) => ({
  playabilityStatus: { status: "OK" },
  streamingData: {
    formats: [
      {
        itag: 18,
        url: mediaUrl(),
        mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
        qualityLabel: "360p",
        height: 360,
        contentLength: "15379389"
      }
    ],
    adaptiveFormats: [
      { itag: 137, url: mediaUrl("v"), mimeType: 'video/mp4; codecs="avc1"', qualityLabel: "1080p", height: 1080 }
    ],
    ...over
  }
});

/** Sequences fetch: first call is the watch page, then the player API. */
function mockFetch(...responses) {
  const spy = jest.fn();
  responses.forEach((r) => spy.mockResolvedValueOnce(r));
  return spy;
}

describe("the watch config", () => {
  test("is scraped from a watch page and reused", async () => {
    const f = mockFetch(html(WATCH_HTML));
    const first = await yt.getWatchConfig(f);
    expect(first).toEqual({ apiKey: "AIzaTESTKEY", visitorData: "CgtWSVNJVE9S" });

    // Cached: a second caller must not refetch a whole HTML page.
    const second = await yt.getWatchConfig(f);
    expect(second).toEqual(first);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("a page missing the markers yields nulls rather than throwing", async () => {
    const f = mockFetch(html("<html>nothing useful</html>"));
    expect(await yt.getWatchConfig(f)).toEqual({ apiKey: null, visitorData: null });
  });

  test("an unreachable YouTube is a 502", async () => {
    const f = jest.fn().mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(yt.getWatchConfig(f)).rejects.toMatchObject({ status: 502 });
  });

  test("a non-200 watch page keeps its status", async () => {
    const f = mockFetch({ ok: false, status: 429, text: async () => "" });
    await expect(yt.getWatchConfig(f)).rejects.toMatchObject({ status: 429 });
  });
});

describe("the player request", () => {
  test("identifies itself as the Android client, with the visitor id", async () => {
    const f = mockFetch(html(WATCH_HTML), json(playerOk()));
    await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });

    const [url, init] = f.mock.calls[1];
    expect(url).toContain("/youtubei/v1/player?key=AIzaTESTKEY");
    expect(init.method).toBe("POST");
    expect(init.headers["X-YouTube-Client-Name"]).toBe("3");
    expect(init.headers["X-Goog-Visitor-Id"]).toBe("CgtWSVNJVE9S");
    expect(init.headers["User-Agent"]).toContain("com.google.android.youtube");

    const body = JSON.parse(init.body);
    expect(body.videoId).toBe("dQw4w9WgXcQ");
    expect(body.context.client.clientName).toBe("ANDROID");
  });

  test("works without an API key, rather than sending the literal word undefined", async () => {
    const f = mockFetch(html("<html>no markers</html>"), json(playerOk()));
    await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });
    const [url, init] = f.mock.calls[1];
    expect(url).toBe("https://www.youtube.com/youtubei/v1/player");
    expect(init.headers["X-Goog-Visitor-Id"]).toBeUndefined();
  });

  test("an unreachable player API is a 502", async () => {
    const f = jest.fn().mockResolvedValueOnce(html(WATCH_HTML)).mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 502 });
  });

  test("a non-200 player API keeps its status", async () => {
    const f = mockFetch(html(WATCH_HTML), json({}, 500));
    await expect(yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 500 });
  });
});

describe("choosing a format", () => {
  test("the progressive list is used, never the adaptive one", () => {
    // An adaptive entry is video OR audio; handing the player one gives a
    // silent picture or a black screen with sound.
    const picked = yt.pickProgressive(playerOk());
    expect(picked.itag).toBe(18);
  });

  test("the tallest progressive format wins when there are several", () => {
    const picked = yt.pickProgressive({
      streamingData: {
        formats: [
          { itag: 18, url: mediaUrl(), mimeType: "video/mp4", height: 360 },
          { itag: 22, url: mediaUrl(), mimeType: "video/mp4", height: 720 }
        ]
      }
    });
    expect(picked.itag).toBe(22);
  });

  test("a format locked behind a signature cipher is skipped", () => {
    const picked = yt.pickProgressive({
      streamingData: { formats: [{ itag: 18, signatureCipher: "s=...", mimeType: "video/mp4" }] }
    });
    expect(picked).toBeNull();
  });

  test("an audio-only progressive entry is not a video", () => {
    const picked = yt.pickProgressive({
      streamingData: { formats: [{ itag: 140, url: mediaUrl(), mimeType: "audio/mp4" }] }
    });
    expect(picked).toBeNull();
  });

  test("an empty or malformed response picks nothing rather than crashing", () => {
    expect(yt.pickProgressive({})).toBeNull();
    expect(yt.pickProgressive(null)).toBeNull();
    expect(yt.pickProgressive({ streamingData: { formats: "not a list" } })).toBeNull();
  });

  test("junk entries in the format list are stepped over", () => {
    const picked = yt.pickProgressive({
      streamingData: {
        formats: [null, { itag: 18, url: mediaUrl(), mimeType: "video/mp4", height: 360 }]
      }
    });
    expect(picked.itag).toBe(18);
  });

  test("a format with no mime type at all is not assumed to be video", () => {
    expect(yt.pickProgressive({ streamingData: { formats: [{ itag: 18, url: mediaUrl() }] } })).toBeNull();
  });

  test("formats with no declared height still sort rather than throw", () => {
    const picked = yt.pickProgressive({
      streamingData: {
        formats: [
          { itag: 18, url: mediaUrl(), mimeType: "video/mp4" },
          { itag: 22, url: mediaUrl(), mimeType: "video/mp4" }
        ]
      }
    });
    expect(picked.itag).toBe(18);
  });
});

describe("resolving a video", () => {
  test("returns the media URL and what the player needs to know about it", async () => {
    const f = mockFetch(html(WATCH_HTML), json(playerOk()));
    const r = await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });
    expect(r.url).toContain("googlevideo.com");
    expect(r.mimeType).toBe("video/mp4"); // codecs stripped
    expect(r.contentLength).toBe(15379389);
    expect(r.quality).toBe("360p");
    expect(r.itag).toBe(18);
  });

  test("the result is cached, so pressing play twice scrapes nothing", async () => {
    const f = mockFetch(html(WATCH_HTML), json(playerOk()));
    await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });
    await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(2); // the first resolve only
  });

  test("a URL that expires too soon is not cached", async () => {
    // Caching it would hand the next viewer a URL already dead on arrival.
    const soon = Math.floor(Date.now() / 1000) + 60;
    const response = playerOk();
    response.streamingData.formats[0].url = mediaUrl("abc", soon);
    const f = mockFetch(html(WATCH_HTML), json(response), json(response));
    await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });
    await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });
    expect(f.mock.calls.length).toBeGreaterThan(2);
  });

  test.each([["short"], ["waaaaaaaaaaytoolong"], [""], [null], [42]])(
    "%p is rejected as a video id before any request",
    async (id) => {
      const f = jest.fn();
      await expect(yt.resolveMediaUrl(id, { fetchImpl: f })).rejects.toMatchObject({ status: 400 });
      expect(f).not.toHaveBeenCalled();
    }
  );

  test("a video YouTube will not serve is a 403 carrying its reason", async () => {
    const f = mockFetch(
      html(WATCH_HTML),
      json({ playabilityStatus: { status: "UNPLAYABLE", reason: "Private video" } })
    );
    await expect(yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({
      status: 403,
      message: "YouTube will not serve this video: Private video"
    });
  });

  test("a status with no reason still says something", async () => {
    const f = mockFetch(html(WATCH_HTML), json({ playabilityStatus: { status: "ERROR" } }));
    await expect(yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({
      message: "YouTube will not serve this video: ERROR"
    });
  });

  test("a response with no playabilityStatus at all is still refused", async () => {
    const f = mockFetch(html(WATCH_HTML), json({}));
    await expect(yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 403 });
  });

  test("LOGIN_REQUIRED throws away the cached config, so the retry gets a fresh visitor id", async () => {
    // Measured live: reusing a spent visitor id keeps returning
    // LOGIN_REQUIRED, and re-scraping clears it.
    const f = mockFetch(html(WATCH_HTML), json({ playabilityStatus: { status: "LOGIN_REQUIRED" } }));
    await expect(yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 403 });
    expect(catalogCache.get(yt.WATCH_CONFIG_KEY)).toBeUndefined();
  });

  test("a playable video with no single-file format is a 415", async () => {
    const f = mockFetch(html(WATCH_HTML), json({ playabilityStatus: { status: "OK" }, streamingData: {} }));
    await expect(yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 415 });
  });

  test("a URL with no readable expiry is used once and never cached", async () => {
    const response = playerOk();
    response.streamingData.formats[0].url = "https://rr5---sn-x.googlevideo.com/videoplayback?itag=18";
    const f = mockFetch(html(WATCH_HTML), json(response), json(response));
    const first = await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });
    expect(first.url).toContain("videoplayback");
    await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });
    expect(f.mock.calls.length).toBeGreaterThan(2);
  });

  test("a format with no declared size or quality still resolves", async () => {
    const response = playerOk();
    delete response.streamingData.formats[0].contentLength;
    delete response.streamingData.formats[0].qualityLabel;
    const f = mockFetch(html(WATCH_HTML), json(response));
    const r = await yt.resolveMediaUrl("dQw4w9WgXcQ", { fetchImpl: f });
    expect(r.contentLength).toBeNull();
    expect(r.quality).toBeNull();
    expect(r.mimeType).toBe("video/mp4");
  });
});

describe("reading a URL's expiry", () => {
  test("comes from the URL's own expire parameter", () => {
    expect(yt.expiryOf(mediaUrl("a", 1790042947))).toBe(1790042947000);
  });

  test("an absent, unparseable or malformed expiry is simply unknown", () => {
    expect(yt.expiryOf("https://example.com/v.mp4")).toBeNull();
    expect(yt.expiryOf("https://example.com/v.mp4?expire=soon")).toBeNull();
    expect(yt.expiryOf("not a url at all")).toBeNull();
    expect(yt.expiryOf("https://example.com/v.mp4?expire=-5")).toBeNull();
  });
});
