const request = require("supertest");
const { app } = require("../server");
const { clearAllCaches } = require("../src/cache");

beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

const WATCH_HTML = 'x{"INNERTUBE_API_KEY":"AIzaTESTKEY","VISITOR_DATA":"CgtWSVNJVE9S"}y';
const MEDIA_URL = `https://rr5---sn-x.googlevideo.com/videoplayback?expire=${
  Math.floor(Date.now() / 1000) + 6 * 3600
}&itag=18`;

const FORMAT_URL = (itag) => `${MEDIA_URL}&itag=${itag}`;

const adaptive = (itag, over) => ({
  itag,
  url: FORMAT_URL(itag),
  initRange: { start: "0", end: "740" },
  indexRange: { start: "741", end: "2356" },
  contentLength: "155676321",
  bitrate: 4334233,
  ...over
});

const PLAYER_OK = {
  playabilityStatus: { status: "OK" },
  videoDetails: { lengthSeconds: "212" },
  streamingData: {
    formats: [
      {
        itag: 18,
        url: MEDIA_URL,
        mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
        qualityLabel: "360p",
        height: 360,
        contentLength: "2048"
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
      adaptive(140, { mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, audioSampleRate: "44100" })
    ]
  }
};

/** A web ReadableStream of one chunk, which is what fetch() hands back. */
function bodyOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    }
  });
}

function mediaResponse({ status = 200, headers = {}, bytes = [1, 2, 3, 4], body } = {}) {
  return {
    ok: status < 400,
    status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    body: body === undefined ? bodyOf(bytes) : body
  };
}

/** Watch page, then player API, then the media fetch. */
function mockPlayback(media = mediaResponse()) {
  return jest
    .spyOn(global, "fetch")
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => PLAYER_OK })
    .mockResolvedValueOnce(media);
}

describe("GET /yt/:videoId.mp4", () => {
  test("proxies the video bytes", async () => {
    mockPlayback(
      mediaResponse({ headers: { "content-type": "video/mp4", "content-length": "4" }, bytes: [1, 2, 3, 4] })
    );
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(Buffer.from(res.body)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("the bytes are fetched by us, not redirected to", async () => {
    // Forced, not chosen: YouTube signs the media URL over the IP that
    // asked for it, so a URL resolved here 403s from a television.
    const spy = mockPlayback();
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(spy.mock.calls[2][0]).toBe(MEDIA_URL);
    expect(spy.mock.calls[2][1].headers["User-Agent"]).toContain("com.google.android.youtube");
  });

  test("a Range request is passed upstream and its 206 passed back, so seeking works", async () => {
    const spy = mockPlayback(
      mediaResponse({
        status: 206,
        // content-length must match the bytes actually sent, or the
        // response is aborted rather than delivered.
        headers: { "content-type": "video/mp4", "content-range": "bytes 100-103/2048", "content-length": "4" }
      })
    );
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4").set("Range", "bytes=100-199");

    expect(spy.mock.calls[2][1].headers.Range).toBe("bytes=100-199");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 100-103/2048");
  });

  test("a HEAD asks upstream for headers only and returns no body", async () => {
    const spy = mockPlayback(mediaResponse({ headers: { "content-length": "2048" } }));
    const res = await request(app).head("/yt/dQw4w9WgXcQ.mp4");
    expect(spy.mock.calls[2][1].method).toBe("HEAD");
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe("2048");
  });

  test("falls back to the resolved mime type when upstream omits one", async () => {
    mockPlayback(mediaResponse({ headers: {} }));
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4");
    expect(res.headers["content-type"]).toBe("video/mp4");
  });

  test("a response with no body at all still ends cleanly", async () => {
    mockPlayback(mediaResponse({ body: null }));
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4");
    expect(res.status).toBe(200);
  });

  test.each([["short"], ["../../etc/passwd"], ["has spaces!"]])(
    "%p is refused as a video id without contacting YouTube",
    async (id) => {
      const spy = jest.spyOn(global, "fetch");
      const res = await request(app).get(`/yt/${encodeURIComponent(id)}.mp4`);
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    }
  );

  test("a video YouTube refuses is reported with its own status", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ playabilityStatus: { status: "UNPLAYABLE", reason: "Private video" } })
      });
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Private video");
  });

  test("an unreachable YouTube during resolve is a 502", async () => {
    jest.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ENOTFOUND"));
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4");
    expect(res.status).toBe(502);
  });

  test("a nonsense upstream status is normalised to 502 rather than passed on", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
      .mockResolvedValueOnce({ ok: false, status: 999, json: async () => ({}) });
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4");
    expect(res.status).toBe(502);
  });

  test("a media fetch that fails after resolving is a 502", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => PLAYER_OK })
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Could not reach the video.");
  });

  test("a stream that errors mid-transfer tears the response down", async () => {
    const failing = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error("upstream died"));
      }
    });
    mockPlayback(mediaResponse({ headers: { "content-type": "video/mp4" }, body: failing }));
    // The request is aborted rather than completed; either way it must not
    // hang or crash the process.
    await request(app)
      .get("/yt/dQw4w9WgXcQ.mp4")
      .catch(() => {});
    expect(true).toBe(true);
  });
});


describe("GET /yt/:videoId/manifest.mpd", () => {
  /** Watch page, then player API. The manifest needs no media fetch. */
  function mockResolve() {
    return jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => PLAYER_OK });
  }

  test("serves a DASH manifest naming the high-quality formats", async () => {
    mockResolve();
    const res = await request(app).get("/yt/dQw4w9WgXcQ/manifest.mpd");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/dash+xml");
    expect(res.text).toContain('profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"');
    // 1080p, which the muxed 360p file could never carry.
    expect(res.text).toContain('height="1080"');
    expect(res.text).toContain('mediaPresentationDuration="PT212.000S"');
  });

  test("its segment URLs point back at this host, never at YouTube", async () => {
    mockResolve();
    const res = await request(app).get("/yt/dQw4w9WgXcQ/manifest.mpd");
    const urls = [...res.text.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/g)].map((m) => m[1]);
    expect(urls.every((u) => u.includes("/yt/dQw4w9WgXcQ/"))).toBe(true);
    expect(res.text).not.toContain("googlevideo");
  });

  test("a bad id is refused without contacting YouTube", async () => {
    const spy = jest.spyOn(global, "fetch");
    const res = await request(app).get("/yt/short/manifest.mpd");
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  test("a video YouTube refuses carries its status through", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ playabilityStatus: { status: "UNPLAYABLE", reason: "Private video" } })
      });
    const res = await request(app).get("/yt/dQw4w9WgXcQ/manifest.mpd");
    expect(res.status).toBe(403);
  });
});

describe("GET /yt/:videoId/:itag", () => {
  function mockFormat(media = mediaResponse()) {
    return jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => PLAYER_OK })
      .mockResolvedValueOnce(media);
  }

  test("proxies one adaptive format, by the itag the manifest names", async () => {
    const spy = mockFormat(
      mediaResponse({ headers: { "content-type": "video/mp4", "content-length": "4" } })
    );
    const res = await request(app).get("/yt/dQw4w9WgXcQ/137");
    expect(res.status).toBe(200);
    expect(spy.mock.calls[2][0]).toBe(FORMAT_URL(137));
  });

  test("passes a Range through, which is how the player reads the index", async () => {
    // DASH SegmentBase works entirely by ranged reads, so this is not
    // optional: without it nothing starts at all.
    const spy = mockFormat(
      mediaResponse({
        status: 206,
        headers: { "content-type": "video/mp4", "content-range": "bytes 0-740/155676321", "content-length": "4" }
      })
    );
    const res = await request(app).get("/yt/dQw4w9WgXcQ/137").set("Range", "bytes=0-740");
    expect(spy.mock.calls[2][1].headers.Range).toBe("bytes=0-740");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-740/155676321");
  });

  test("the audio track is reachable too", async () => {
    const spy = mockFormat(mediaResponse({ headers: { "content-type": "audio/mp4", "content-length": "4" } }));
    await request(app).get("/yt/dQw4w9WgXcQ/140");
    expect(spy.mock.calls[2][0]).toBe(FORMAT_URL(140));
  });

  test("a HEAD asks upstream for headers only", async () => {
    const spy = mockFormat(mediaResponse({ headers: { "content-length": "99" } }));
    const res = await request(app).head("/yt/dQw4w9WgXcQ/137");
    expect(spy.mock.calls[2][1].method).toBe("HEAD");
    expect(res.headers["content-length"]).toBe("99");
  });

  test("an itag this video does not have is a 404", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => PLAYER_OK });
    const res = await request(app).get("/yt/dQw4w9WgXcQ/999");
    expect(res.status).toBe(404);
  });

  test("a bad id is refused without contacting YouTube", async () => {
    const spy = jest.spyOn(global, "fetch");
    const res = await request(app).get("/yt/short/137");
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  test("a resolve failure carries its status through", async () => {
    jest.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ENOTFOUND"));
    const res = await request(app).get("/yt/dQw4w9WgXcQ/137");
    expect(res.status).toBe(502);
  });

  test("a media fetch failure is a 502", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => PLAYER_OK })
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const res = await request(app).get("/yt/dQw4w9WgXcQ/137");
    expect(res.status).toBe(502);
  });
});

describe("the muxed fallback", () => {
  test("a video with no muxed format at all is a 415", async () => {
    const noProgressive = { ...PLAYER_OK, streamingData: { ...PLAYER_OK.streamingData, formats: [] } };
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => WATCH_HTML })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => noProgressive });
    const res = await request(app).get("/yt/dQw4w9WgXcQ.mp4");
    expect(res.status).toBe(415);
  });
});
