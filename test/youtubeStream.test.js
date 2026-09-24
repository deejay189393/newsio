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

/** An adaptive entry, shaped as the player response really returns one. */
const adaptive = (itag, over = {}) => ({
  itag,
  url: mediaUrl(String(itag)),
  initRange: { start: "0", end: "740" },
  indexRange: { start: "741", end: "2356" },
  contentLength: "155676321",
  bitrate: 4334233,
  ...over
});

const playerOk = (over = {}) => ({
  playabilityStatus: { status: "OK" },
  videoDetails: { lengthSeconds: "212" },
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
      adaptive(137, {
        mimeType: 'video/mp4; codecs="avc1.640028"',
        qualityLabel: "1080p",
        width: 1920,
        height: 1080,
        fps: 30
      }),
      adaptive(136, {
        mimeType: 'video/mp4; codecs="avc1.4d401f"',
        qualityLabel: "720p",
        width: 1280,
        height: 720,
        fps: 30,
        bitrate: 1968815
      }),
      adaptive(140, {
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 130000,
        audioSampleRate: "44100"
      }),
      // VP9 at the same height, which must lose to H.264.
      adaptive(248, { mimeType: 'video/webm; codecs="vp9"', qualityLabel: "1080p", height: 1080 }),
      // Opus, which must lose to AAC.
      adaptive(251, { mimeType: 'audio/webm; codecs="opus"', bitrate: 154209 })
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
    expect(first).toMatchObject({ apiKey: "AIzaTESTKEY", visitorData: "CgtWSVNJVE9S" });
    // Stamped, so a later refusal can tell a fresh config from a stale one.
    expect(typeof first.fetchedAt).toBe("number");

    // Cached: a second caller must not refetch a whole HTML page.
    const second = await yt.getWatchConfig(f);
    expect(second).toEqual(first);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("a page missing the markers yields nulls rather than throwing", async () => {
    const f = mockFetch(html("<html>nothing useful</html>"));
    expect(await yt.getWatchConfig(f)).toMatchObject({ apiKey: null, visitorData: null });
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
    await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });

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
    await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    const [url, init] = f.mock.calls[1];
    expect(url).toBe("https://www.youtube.com/youtubei/v1/player");
    expect(init.headers["X-Goog-Visitor-Id"]).toBeUndefined();
  });

  test("an unreachable player API is a 502", async () => {
    const f = jest.fn().mockResolvedValueOnce(html(WATCH_HTML)).mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 502 });
  });

  test("a non-200 player API keeps its status", async () => {
    const f = mockFetch(html(WATCH_HTML), json({}, 500));
    await expect(yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 500 });
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
  test("returns the muxed file, the adaptive ladder and the running time", async () => {
    const f = mockFetch(html(WATCH_HTML), json(playerOk()));
    const r = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });

    expect(r.progressive.url).toContain("googlevideo.com");
    expect(r.progressive.mimeType).toBe("video/mp4"); // codecs stripped
    expect(r.progressive.contentLength).toBe(15379389);
    expect(r.progressive.itag).toBe(18);

    expect(r.adaptive.video.map((v) => v.itag)).toEqual([137, 136]);
    expect(r.adaptive.audio.itag).toBe(140);
    expect(r.durationSeconds).toBe(212);
    // The label the stream shows is what the manifest can actually deliver,
    // not the 360p the muxed file is stuck at.
    expect(r.bestQuality).toBe("1080p");
  });

  test("every format the manifest names can be looked up by itag", async () => {
    const f = mockFetch(html(WATCH_HTML), json(playerOk()));
    const r = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect([...r.byItag.keys()].sort()).toEqual(["136", "137", "140", "18"]);
    expect(r.byItag.get("137").mimeType).toBe("video/mp4");
  });

  test("the result is cached, so pressing play twice scrapes nothing", async () => {
    const f = mockFetch(html(WATCH_HTML), json(playerOk()));
    await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(2); // the first resolve only
  });

  test("a URL that expires too soon is not cached", async () => {
    // Caching it would hand the next viewer a URL already dead on arrival.
    const soon = Math.floor(Date.now() / 1000) + 60;
    const response = playerOk();
    // Expiry is read from whichever URL the manifest will actually use.
    response.streamingData.adaptiveFormats[0].url = mediaUrl("abc", soon);
    const f = mockFetch(html(WATCH_HTML), json(response), json(response));
    await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(f.mock.calls.length).toBeGreaterThan(2);
  });

  test.each([["short"], ["waaaaaaaaaaytoolong"], [""], [null], [42]])(
    "%p is rejected as a video id before any request",
    async (id) => {
      const f = jest.fn();
      await expect(yt.resolveVideo(id, { fetchImpl: f })).rejects.toMatchObject({ status: 400 });
      expect(f).not.toHaveBeenCalled();
    }
  );

  test("a video YouTube will not serve is a 403 carrying its reason", async () => {
    const f = mockFetch(
      html(WATCH_HTML),
      json({ playabilityStatus: { status: "UNPLAYABLE", reason: "Private video" } })
    );
    await expect(yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({
      status: 403,
      message: "YouTube will not serve this video: Private video"
    });
  });

  test("a status with no reason still says something", async () => {
    const f = mockFetch(html(WATCH_HTML), json({ playabilityStatus: { status: "ERROR" } }));
    await expect(yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({
      message: "YouTube will not serve this video: ERROR"
    });
  });

  test("a response with no playabilityStatus at all is still refused", async () => {
    const f = mockFetch(html(WATCH_HTML), json({}));
    await expect(yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 403 });
  });

  test("a refusal keeps a freshly scraped config, rather than refetching the page it just got", async () => {
    // The failure path used to drop the config every time, so a sustained
    // block became one full watch-page fetch per press of play against the
    // endpoint already answering 429.
    const f = mockFetch(html(WATCH_HTML), json({ playabilityStatus: { status: "LOGIN_REQUIRED" } }));
    await expect(yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 403 });
    expect(catalogCache.get(yt.WATCH_CONFIG_KEY)).toBeTruthy();
  });

  test("a refusal does drop a config old enough to actually be stale", async () => {
    const f = mockFetch(html(WATCH_HTML), json({ playabilityStatus: { status: "LOGIN_REQUIRED" } }));
    const realNow = Date.now;
    // Fetch the config, then age it past the floor before the refusal lands.
    Date.now = () => realNow() - yt.RESCRAPE_FLOOR_MS - 1000;
    await yt.getWatchConfig(f);
    Date.now = realNow;
    await expect(yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 403 });
    expect(catalogCache.get(yt.WATCH_CONFIG_KEY)).toBeUndefined();
  });

  describe("deciding whether to scrape the watch page again", () => {
    const aged = (ms) => ({ fetchedAt: Date.now() - ms });

    test("not for a status a new visitor id cannot fix", () => {
      expect(yt.staleEnoughToRescrape(aged(60 * 60 * 1000), "ERROR")).toBe(false);
      expect(yt.staleEnoughToRescrape(aged(60 * 60 * 1000), "OK")).toBe(false);
    });

    test("not while the current one is younger than the floor", () => {
      expect(yt.staleEnoughToRescrape(aged(0), "LOGIN_REQUIRED")).toBe(false);
      expect(yt.staleEnoughToRescrape(aged(yt.RESCRAPE_FLOOR_MS - 1000), "UNPLAYABLE")).toBe(false);
    });

    test("yes once it is older than the floor", () => {
      expect(yt.staleEnoughToRescrape(aged(yt.RESCRAPE_FLOOR_MS + 1000), "LOGIN_REQUIRED")).toBe(true);
      expect(yt.staleEnoughToRescrape(aged(yt.RESCRAPE_FLOOR_MS + 1000), "UNPLAYABLE")).toBe(true);
    });

    test("a config with no timestamp counts as ancient", () => {
      expect(yt.staleEnoughToRescrape({}, "LOGIN_REQUIRED")).toBe(true);
      expect(yt.staleEnoughToRescrape(null, "LOGIN_REQUIRED")).toBe(true);
    });
  });

  test("a playable video with no usable format at all is a 415", async () => {
    const f = mockFetch(html(WATCH_HTML), json({ playabilityStatus: { status: "OK" }, streamingData: {} }));
    await expect(yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f })).rejects.toMatchObject({ status: 415 });
  });

  test("a URL with no readable expiry is used once and never cached", async () => {
    const response = playerOk();
    response.streamingData.adaptiveFormats[0].url = "https://rr5---sn-x.googlevideo.com/videoplayback?itag=137";
    const f = mockFetch(html(WATCH_HTML), json(response), json(response));
    const first = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(first.adaptive.video[0].url).toContain("videoplayback");
    await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(f.mock.calls.length).toBeGreaterThan(2);
  });

  test("a format with no declared size or quality still resolves", async () => {
    const response = playerOk();
    delete response.streamingData.formats[0].contentLength;
    delete response.streamingData.formats[0].qualityLabel;
    const f = mockFetch(html(WATCH_HTML), json(response));
    const r = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(r.progressive.contentLength).toBeNull();
    expect(r.progressive.quality).toBeNull();
    expect(r.progressive.mimeType).toBe("video/mp4");
  });

  test("a video with adaptive formats but nothing muxed still resolves", async () => {
    // The manifest is what plays; the muxed file is only a fallback.
    const response = playerOk();
    response.streamingData.formats = [];
    const f = mockFetch(html(WATCH_HTML), json(response));
    const r = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(r.progressive).toBeNull();
    expect(r.adaptive.video.length).toBeGreaterThan(0);
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

describe("choosing the adaptive ladder", () => {
  const pick = (formats) => yt.pickAdaptive({ streamingData: { adaptiveFormats: formats } });

  test("H.264 wins over VP9 and AV1 at the same resolution", () => {
    // Televisions decode H.264 in hardware far more reliably; a format the
    // TV cannot decode is worse than one a notch smaller.
    const { video } = pick([
      adaptive(248, { mimeType: 'video/webm; codecs="vp9"', height: 1080 }),
      adaptive(399, { mimeType: 'video/mp4; codecs="av01.0.08M.08"', height: 1080 }),
      adaptive(137, { mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080 })
    ]);
    expect(video.map((v) => v.itag)).toEqual([137]);
  });

  test("AAC wins over Opus for audio", () => {
    const { audio } = pick([
      adaptive(251, { mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 }),
      adaptive(140, { mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000 })
    ]);
    // Opus is the higher bitrate here and still loses: container matters more.
    expect(audio.itag).toBe(140);
  });

  test("the ladder is tallest first, one representation per resolution", () => {
    const { video } = pick([
      adaptive(136, { mimeType: 'video/mp4; codecs="avc1"', height: 720, bitrate: 1000 }),
      adaptive(137, { mimeType: 'video/mp4; codecs="avc1"', height: 1080, bitrate: 4000 }),
      adaptive(298, { mimeType: 'video/mp4; codecs="avc1"', height: 720, bitrate: 2000 }),
      adaptive(135, { mimeType: 'video/mp4; codecs="avc1"', height: 480, bitrate: 500 })
    ]);
    expect(video.map((v) => v.height)).toEqual([1080, 720, 480]);
    // Of the two 720p encodes, the richer one is kept.
    expect(video[1].itag).toBe(298);
  });

  test("a format missing the byte ranges a manifest needs is dropped", () => {
    // A Representation without its index and init ranges cannot be started.
    const { video } = pick([
      { itag: 137, url: "https://x", mimeType: 'video/mp4; codecs="avc1"', height: 1080, contentLength: "1" },
      adaptive(136, { mimeType: 'video/mp4; codecs="avc1"', height: 720 })
    ]);
    expect(video.map((v) => v.itag)).toEqual([136]);
  });

  test("a ciphered format is dropped", () => {
    const { video } = pick([
      adaptive(137, { mimeType: 'video/mp4; codecs="avc1"', height: 1080, url: undefined, signatureCipher: "s=x" })
    ]);
    expect(video).toEqual([]);
  });

  test("entries with no mime type or no bitrate are handled, not crashed on", () => {
    const { video, audio } = pick([
      adaptive(1, { mimeType: undefined }),
      adaptive(137, { mimeType: 'video/mp4; codecs="avc1"', height: 1080, bitrate: undefined }),
      adaptive(140, { mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: undefined }),
      adaptive(141, { mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 200000 })
    ]);
    expect(video.map((v) => v.itag)).toEqual([137]);
    expect(audio.itag).toBe(141);
  });

  test("video but no usable audio yields a null audio track", () => {
    const { video, audio } = pick([adaptive(137, { mimeType: 'video/mp4; codecs="avc1"', height: 1080 })]);
    expect(video).toHaveLength(1);
    expect(audio).toBeNull();
  });

  test("nothing adaptive at all is empty rather than a crash", () => {
    expect(yt.pickAdaptive({})).toEqual({ video: [], audio: null });
    expect(yt.pickAdaptive(null)).toEqual({ video: [], audio: null });
    expect(pick("not a list")).toEqual({ video: [], audio: null });
  });
});

describe("the DASH manifest", () => {
  const video = [
    adaptive(137, { mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, fps: 30 }),
    adaptive(136, {
      mimeType: 'video/mp4; codecs="avc1.4d401f"',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 1968815
    })
  ];
  const audio = adaptive(140, {
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: 130000,
    audioSampleRate: "44100"
  });
  const build = (over = {}) =>
    yt.buildDashManifest({ video, audio, durationSeconds: 212, baseUrl: "https://h/yt/vid", ...over });

  test("is well-formed on-demand DASH", () => {
    const m = build();
    expect(m).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(m).toContain('profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"');
    expect(m).toContain('type="static"');
    expect(m).toContain('mediaPresentationDuration="PT212.000S"');
    expect(m.trimEnd().endsWith("</MPD>")).toBe(true);
  });

  test("parses as XML with the structure a player walks", () => {
    const { JSDOM } = require("jsdom");
    const doc = new JSDOM(build(), { contentType: "text/xml" }).window.document;
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll("AdaptationSet")).toHaveLength(2);
    expect(doc.querySelectorAll("Representation")).toHaveLength(3);
    const first = doc.querySelector('Representation[id="137"]');
    expect(first.getAttribute("width")).toBe("1920");
    expect(first.querySelector("SegmentBase").getAttribute("indexRange")).toBe("741-2356");
    expect(first.querySelector("Initialization").getAttribute("range")).toBe("0-740");
  });

  test("every segment URL points back at this addon, never at YouTube", () => {
    // The underlying URLs are IP-locked to whoever resolved them, so the
    // player must fetch every byte through us.
    const m = build();
    const urls = [...m.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/g)].map((x) => x[1]);
    expect(urls).toEqual(["https://h/yt/vid/137", "https://h/yt/vid/136", "https://h/yt/vid/140"]);
    expect(m).not.toContain("googlevideo");
  });

  test("declares the audio channel configuration", () => {
    expect(build()).toContain("urn:mpeg:dash:23003:3:audio_channel_configuration:2011");
  });

  test("a video with no audio track still yields a manifest", () => {
    const m = build({ audio: null });
    expect(m).toContain('contentType="video"');
    expect(m).not.toContain('contentType="audio"');
  });

  test("no video representations leaves an empty period rather than broken XML", () => {
    const { JSDOM } = require("jsdom");
    const m = build({ video: [], audio: null });
    const doc = new JSDOM(m, { contentType: "text/xml" }).window.document;
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll("AdaptationSet")).toHaveLength(0);
  });

  test("a base URL containing XML-special characters is escaped", () => {
    const m = build({ baseUrl: "https://h/yt/a&b" });
    expect(m).toContain("https://h/yt/a&amp;b/137");
  });
});

describe("small helpers", () => {
  test.each([
    ['video/mp4; codecs="avc1.640028"', "avc1.640028"],
    ['audio/mp4; codecs="mp4a.40.2"', "mp4a.40.2"],
    ["video/mp4", ""],
    [undefined, ""]
  ])("codecs of %p is %p", (mime, codecs) => {
    expect(yt.codecsOf(mime)).toBe(codecs);
  });

  test.each([
    [212, "PT212.000S"],
    [0, "PT0.000S"],
    [360.048, "PT360.048S"],
    [undefined, "PT0.000S"],
    [-5, "PT0.000S"]
  ])("%p seconds is %p", (seconds, iso) => {
    expect(yt.isoDuration(seconds)).toBe(iso);
  });
});

describe("when YouTube leaves optional fields out", () => {
  // Every one of these is a field the player response usually carries and
  // occasionally does not. None should break playback.
  const sparseVideo = { itag: 137, url: mediaUrl("137"), mimeType: 'video/mp4; codecs="avc1"', height: 1080 };
  const withRanges = { ...sparseVideo, initRange: { start: "0", end: "1" }, indexRange: { start: "2", end: "3" }, contentLength: "9" };

  test("a manifest renders without bitrate, fps or sample rate", () => {
    const m = yt.buildDashManifest({
      video: [withRanges],
      audio: { ...withRanges, itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
      durationSeconds: 10,
      baseUrl: "https://h/yt/v"
    });
    expect(m).toContain('bandwidth="0"');
    expect(m).toContain('frameRate="30"'); // assumed
    expect(m).toContain('audioSamplingRate="44100"'); // assumed
  });

  test("no videoDetails means no duration rather than a crash", async () => {
    const response = playerOk();
    delete response.videoDetails;
    const f = mockFetch(html(WATCH_HTML), json(response));
    const r = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(r.durationSeconds).toBe(0);
  });

  test("a format with no mime type is dropped, not proxied blind", async () => {
    // Without one there is no way to tell picture from sound, and both
    // pickers require it, so such a format never reaches the manifest.
    const response = playerOk();
    delete response.streamingData.formats[0].mimeType;
    const f = mockFetch(html(WATCH_HTML), json(response));
    const r = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(r.progressive).toBeNull();
    expect(r.byItag.get("18")).toBeUndefined();
  });

  test("the quality label falls back to the height", async () => {
    const response = playerOk();
    delete response.streamingData.adaptiveFormats[0].qualityLabel;
    const f = mockFetch(html(WATCH_HTML), json(response));
    const r = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(r.bestQuality).toBe("1080p");
  });

  test("with nothing adaptive, the label and expiry come from the muxed file", async () => {
    const response = playerOk();
    response.streamingData.adaptiveFormats = [];
    const f = mockFetch(html(WATCH_HTML), json(response));
    const r = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl: f });
    expect(r.adaptive.video).toEqual([]);
    expect(r.bestQuality).toBe("360p");
    expect(r.byItag.get("18")).toBeTruthy();
  });

  test("sorting survives one side of a comparison missing its bitrate", () => {
    const { video, audio } = yt.pickAdaptive({
      streamingData: {
        adaptiveFormats: [
          // Three at the same height, so the bitrate tiebreak is exercised
          // with the missing value on each side of the comparison.
          { ...withRanges, itag: 1, height: 720, bitrate: undefined },
          { ...withRanges, itag: 2, height: 720, bitrate: 900 },
          { ...withRanges, itag: 5, height: 720, bitrate: 400 },
          { ...withRanges, itag: 3, mimeType: 'audio/mp4; codecs="mp4a"', bitrate: undefined },
          { ...withRanges, itag: 4, mimeType: 'audio/mp4; codecs="mp4a"', bitrate: 500 }
        ]
      }
    });
    expect(video[0].itag).toBe(2);
    expect(audio.itag).toBe(4);
  });

  test("sorting survives the missing field being on either side", () => {
    // A comparator sees each pair in both orders; both sides need the guard.
    const { video, audio } = yt.pickAdaptive({
      streamingData: {
        adaptiveFormats: [
          { ...withRanges, itag: 1, height: 1080, bitrate: 900 },
          { ...withRanges, itag: 2, height: undefined, bitrate: undefined },
          { ...withRanges, itag: 3, height: 720, bitrate: 500 },
          { ...withRanges, itag: 4, mimeType: 'audio/mp4; codecs="mp4a"', bitrate: 500 },
          { ...withRanges, itag: 5, mimeType: 'audio/mp4; codecs="mp4a"', bitrate: undefined }
        ]
      }
    });
    expect(video.map((v) => v.itag)).toEqual([1, 3, 2]);
    expect(audio.itag).toBe(4);
  });

  test("sorting survives formats with no height at all", () => {
    const { video } = yt.pickAdaptive({
      streamingData: {
        adaptiveFormats: [
          { ...withRanges, itag: 1, height: undefined, bitrate: 100 },
          { ...withRanges, itag: 2, height: undefined, bitrate: 900 }
        ]
      }
    });
    // Same (absent) height, so the richer encode leads.
    expect(video[0].itag).toBe(2);
  });
});

describe("one resolve per video at a time", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };

  test("requests for a video already being resolved join that resolve", async () => {
    const d = deferred();
    const fetchImpl = jest.fn(async (url) => (String(url).includes("/watch?") ? html(WATCH_HTML) : d.promise));
    const a = yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl });
    const b = yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl });
    const c = yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl });
    await new Promise((r) => setImmediate(r));
    d.resolve(json(playerOk()));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe(rb);
    expect(rb).toBe(rc);
    const playerCalls = fetchImpl.mock.calls.filter((call) => !String(call[0]).includes("/watch?"));
    expect(playerCalls).toHaveLength(1);
  });

  test("a refusal reaches every request that joined, from one call to YouTube", async () => {
    const d = deferred();
    const fetchImpl = jest.fn(async (url) => (String(url).includes("/watch?") ? html(WATCH_HTML) : d.promise));
    const a = yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl });
    const b = yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl });
    await new Promise((r) => setImmediate(r));
    d.resolve(json({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you’re not a bot" } }));
    await expect(a).rejects.toMatchObject({ status: 403 });
    await expect(b).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl.mock.calls.filter((call) => !String(call[0]).includes("/watch?"))).toHaveLength(1);
  });

  test("a failure is not remembered: the next request asks YouTube again", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(html(WATCH_HTML))
      .mockResolvedValueOnce(json({ playabilityStatus: { status: "LOGIN_REQUIRED" } }))
      .mockResolvedValueOnce(json(playerOk()));
    await expect(yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl })).rejects.toMatchObject({ status: 403 });
    const resolved = await yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl });
    expect(resolved.bestQuality).toBe("1080p");
  });

  test("different videos resolve independently", async () => {
    const fetchImpl = jest.fn(async (url) => (String(url).includes("/watch?") ? html(WATCH_HTML) : json(playerOk())));
    await Promise.all([yt.resolveVideo("dQw4w9WgXcQ", { fetchImpl }), yt.resolveVideo("jNQXAC9IVRw", { fetchImpl })]);
    expect(fetchImpl.mock.calls.filter((call) => !String(call[0]).includes("/watch?"))).toHaveLength(2);
  });
});
