/**
 * Behavioural tests for the configure page's inline script.
 *
 * The rest of the configure-page suite asserts on the rendered HTML as a
 * string, which cannot see whether that script actually *runs*: a script
 * with a syntax error still contains all the right substrings. That gap let
 * a broken regex ship -- the escapes were eaten by the template literal, the
 * script threw at parse time, no submit handler was ever attached, and
 * "Generate install link" fell through to a native form GET that just
 * reloaded the page.
 *
 * These tests execute the page in a real DOM and drive the actual controls.
 */
const { JSDOM, VirtualConsole } = require("jsdom");
const { renderConfigurePage } = require("../src/configurePage");
const { decodeConfig } = require("../src/config");
const { PRESET_TOPICS } = require("../src/topics");
const presetLabel = (id) => PRESET_TOPICS.find((t) => t.id === id).label;

const BASE = "https://newsio.up.railway.app";

// Every JSDOM window is torn down after each test: the page's "Copied!"
// reset is a 1.5s setTimeout, and a window left open keeps that timer --
// and the Jest worker -- alive past the end of the run.
const openWindows = [];
afterEach(() => {
  while (openWindows.length) openWindows.pop().close();
});

/** Load the rendered page into a DOM, executing its inline script. */
function loadPage(options = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => errors.push(err));
  virtualConsole.on("error", (msg) => errors.push(new Error(msg)));

  const dom = new JSDOM(renderConfigurePage({ baseUrl: BASE, existing: null, ...options }), {
    runScripts: "dangerously",
    url: BASE + "/configure",
    virtualConsole
  });
  openWindows.push(dom.window);

  const { document } = dom.window;
  return {
    dom,
    document,
    errors,
    submit: () => {
      const form = document.getElementById("config-form");
      const event = new dom.window.Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
      return event;
    },
    setKey: (provider, v) => {
      document.querySelector(`.source[data-provider="${provider}"] .source-key`).value = v;
      document.getElementById("sources-list").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    },
    // Types into one key field the way a person does: the event comes from
    // the field itself, so the page can tell which card it belongs to.
    typeKey: (provider, v) => {
      const field = document.querySelector(`.source[data-provider="${provider}"] .source-key`);
      field.value = v;
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    },
    // The on/off switch a keyless source has instead of a required key.
    setSwitch: (provider, on) => {
      const box = document.querySelector(`.source[data-provider="${provider}"] .source-on`);
      box.checked = on;
      box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    switchOf: (provider) => document.querySelector(`.source[data-provider="${provider}"] .source-on`),
    generated: () => {
      const url = document.getElementById("manifest-url").value;
      return url.slice(BASE.length + 1, -"/manifest.json".length);
    },
    click: (selector) => {
      document.querySelector(selector).dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    },
    cardOrder: () =>
      Array.from(document.querySelectorAll(".source")).map((el) => el.getAttribute("data-provider")),
    ranks: () => Array.from(document.querySelectorAll(".source-rank")).map((el) => el.textContent),
    // Presets are added by clicking their chip in the "Add a preset" row.
    check: (...ids) => {
      ids.forEach((id) => {
        const label = presetLabel(id);
        const chip = Array.from(document.querySelectorAll("#preset-chips button")).find(
          (b) => b.textContent === `+ ${label}`
        );
        if (!chip) throw new Error(`no preset chip for ${id}`);
        chip.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
      });
    },
    addCustom: (text) => {
      document.getElementById("custom-topic").value = text;
      document.getElementById("add-custom").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    },
    topicRows: () =>
      Array.from(document.querySelectorAll(".topic-row")).map((r) => ({
        id: r.getAttribute("data-topic-id"),
        label: r.querySelector(".topic-label").textContent,
        rank: r.querySelector(".topic-rank").textContent
      })),
    topicIds: () =>
      Array.from(document.querySelectorAll(".topic-row")).map((r) => r.getAttribute("data-topic-id")),
    rowButton: (id, cls) =>
      document.querySelector(`.topic-row[data-topic-id="${id}"] .${cls}`),
    checkedTopics: () =>
      Array.from(document.querySelectorAll(".topic-row")).map((r) => r.getAttribute("data-topic-id"))
  };
}

describe("configure page — the inline script runs at all", () => {
  test("executes without a script error", () => {
    const { errors } = loadPage();
    expect(errors.map((e) => e.message || String(e))).toEqual([]);
  });

  test("the emitted script is syntactically valid JavaScript", () => {
    const html = renderConfigurePage({ baseUrl: BASE, existing: null });
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    expect(() => new Function(script)).not.toThrow();
  });

  test("emits no accidental line comment from an eaten regex escape", () => {
    const html = renderConfigurePage({ baseUrl: BASE, existing: null });
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    expect(script).not.toMatch(/replace\(\/\//);
    expect(script).not.toContain("https?:///");
  });
});

describe("configure page — Generate install link", () => {
  test("prevents the native form submit that would reload the page", () => {
    const page = loadPage();
    page.setKey("newsdata", "pub_abc123");
    page.check("technology");
    const event = page.submit();
    expect(event.defaultPrevented).toBe(true);
  });

  test("reveals the result box and fills both the install link and the URL", () => {
    const page = loadPage();
    page.setKey("newsdata", "pub_abc123");
    page.check("technology", "world");
    page.submit();

    const result = page.document.getElementById("result");
    const href = page.document.getElementById("install-link").getAttribute("href");
    const manifestUrl = page.document.getElementById("manifest-url").value;

    expect(result.className).toContain("show");
    expect(href.startsWith("stremio://")).toBe(true);
    expect(href).not.toContain("https://");
    expect(manifestUrl.startsWith(BASE + "/")).toBe(true);
    expect(manifestUrl.endsWith("/manifest.json")).toBe(true);
  });

  test("the generated URL carries a config the server can decode back", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.setKey("newsdata", "pub_abc123");
    page.check("technology", "world");
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);

    expect(decodeConfig(segment)).toEqual({
      sources: [{ provider: "newsdata", apiKey: "pub_abc123" }],
      // The order topics were added in is the order they are stored in,
      // because that is the order their catalogs appear in Stremio.
      topics: [
        { kind: "preset", id: "technology", label: "Technology" },
        { kind: "preset", id: "world", label: "World" }
      ],
      language: "en",
      youtubeStreams: ["app", "youtube"],
      youtubeNews: true
    });
  });

  test("the install link and the copyable URL describe the same addon", () => {
    const page = loadPage();
    page.setKey("newsdata", "pub_abc123");
    page.check("top");
    page.submit();

    const href = page.document.getElementById("install-link").getAttribute("href");
    const manifestUrl = page.document.getElementById("manifest-url").value;
    expect(href).toBe(manifestUrl.replace(/^https:\/\//, "stremio://"));
  });

  test("carries the chosen language through to the config", () => {
    const page = loadPage();
    page.setKey("newsdata", "pub_abc123");
    page.check("top");
    page.document.getElementById("language").value = "fr";
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).language).toBe("fr");
  });

  test("percent-encodes the config into exactly one path segment", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.setKey("newsdata", "pub abc/123");
    page.check("top");
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);
    expect(segment).not.toContain("/");
    expect(decodeConfig(segment).sources[0].apiKey).toBe("pub abc/123");
  });
});

describe("configure page — validation", () => {
  test("refuses when no source is in use, and says so", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.check("technology");
    page.submit();

    const error = page.document.getElementById("error");
    expect(error.style.display).toBe("block");
    expect(error.textContent).toContain("at least one news source");
    expect(page.document.getElementById("result").className).not.toContain("show");
  });

  test("refuses when no catalog is added and says so", () => {
    const page = loadPage();
    page.setKey("newsdata", "pub_abc123");
    page.submit();

    const error = page.document.getElementById("error");
    expect(error.style.display).toBe("block");
    expect(error.textContent).toContain("at least one catalog");
    expect(page.document.getElementById("result").className).not.toContain("show");
  });

  test("trims surrounding whitespace from the API key", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.setKey("newsdata", "   pub_abc123   ");
    page.check("top");
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).sources).toEqual([{ provider: "newsdata", apiKey: "pub_abc123" }]);
  });

  test("clears a previous error once the form is valid", () => {
    const page = loadPage();
    page.submit();
    expect(page.document.getElementById("error").style.display).toBe("block");

    page.setKey("newsdata", "pub_abc123");
    page.check("top");
    page.submit();
    expect(page.document.getElementById("error").style.display).toBe("none");
    expect(page.document.getElementById("result").className).toContain("show");
  });
});

describe("configure page — re-configuration round trip", () => {
  test("pre-filled settings regenerate the same config when submitted unchanged", () => {
    const existing = {
      sources: [
        { provider: "newsdata", apiKey: "pub_secret123" },
        { provider: "currents", apiKey: "cur_abc" }
      ],
      topics: ["technology", "business"],
      language: "fr"
    };
    const page = loadPage({ existing });
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);
    const decoded = decodeConfig(segment);

    expect(decoded.sources).toEqual(existing.sources);
    expect(decoded.language).toBe(existing.language);
    expect(decoded.topics.map((t) => t.id)).toEqual(["technology", "business"]);
  });
});

describe("configure page — copy button", () => {
  test("falls back to selecting the input when the clipboard API is absent", () => {
    const page = loadPage();
    page.setKey("newsdata", "pub_abc123");
    page.check("top");
    page.submit();

    const input = page.document.getElementById("manifest-url");
    let selected = false;
    input.select = () => {
      selected = true;
    };
    page.document.getElementById("copy-btn").dispatchEvent(
      new page.dom.window.Event("click", { bubbles: true })
    );
    expect(selected).toBe(true);
  });

  test("uses the clipboard API when available", async () => {
    const page = loadPage();
    page.setKey("newsdata", "pub_abc123");
    page.check("top");
    page.submit();

    let written = null;
    Object.defineProperty(page.dom.window.navigator, "clipboard", {
      value: { writeText: (v) => ((written = v), Promise.resolve()) },
      configurable: true
    });

    const copyBtn = page.document.getElementById("copy-btn");
    copyBtn.dispatchEvent(new page.dom.window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(written).toBe(page.document.getElementById("manifest-url").value);
    expect(copyBtn.textContent).toBe("Copied!");
  });
});

describe("configure page — script injection safety", () => {
  test("a hostile Host header cannot break out of the inline script", () => {
    const { errors, dom } = (() => {
      const html = renderConfigurePage({
        baseUrl: 'https://evil</script><script>window.PWNED=1;</script><script>',
        existing: null
      });
      const vc = new VirtualConsole();
      const errs = [];
      vc.on("jsdomError", (e) => errs.push(e));
      const d = new JSDOM(html, { runScripts: "dangerously", virtualConsole: vc });
      openWindows.push(d.window);
      return { errors: errs, dom: d };
    })();

    expect(dom.window.PWNED).toBeUndefined();
    expect(errors).toEqual([]);
  });
});

describe("configure page — the failover chain", () => {
  test("a key in any source is enough to generate a link", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.setKey("gnews", "gn_key");
    page.check("technology");
    page.submit();
    const url = page.document.getElementById("manifest-url").value;
    const segment = url.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).sources).toEqual([{ provider: "gnews", apiKey: "gn_key" }]);
  });

  test("several keys become an ordered chain, in the order shown on the page", () => {
    const page = loadPage();
    // Every provider keyed, so the encoded chain and the card order are
    // directly comparable; the gap case has its own test above.
    page.setKey("currents", "c1");
    page.setKey("newsdata", "n1");
    page.setKey("youtube", "y1");
    page.setKey("gnews", "g1");
    page.check("top");
    page.submit();
    const url = page.document.getElementById("manifest-url").value;
    const segment = url.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).sources.map((s) => s.provider)).toEqual(page.cardOrder());
  });

  test("moving a source up changes the failover order that is generated", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.setKey("currents", "c1");
    page.setKey("newsdata", "n1");
    page.check("top");

    // YouTube and NewsMCP head the default chain, so the pair under test
    // sits at 2..3.
    expect(page.cardOrder().slice(0, 4)).toEqual(["youtube", "newsmcp", "currents", "newsdata"]);
    page.click('.source[data-provider="newsdata"] .move-up');
    expect(page.cardOrder().slice(2, 4)).toEqual(["newsdata", "currents"]);

    page.submit();
    const url = page.document.getElementById("manifest-url").value;
    const segment = url.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).sources.map((s) => s.provider)).toEqual(["newsdata", "currents"]);
  });

  test("moving a source down changes it too", () => {
    const page = loadPage();
    page.setKey("currents", "c1");
    page.setKey("newsdata", "n1");
    page.check("top");
    page.click('.source[data-provider="currents"] .move-down');
    expect(page.cardOrder().slice(2, 4)).toEqual(["newsdata", "currents"]);
  });

  test("the first card cannot move up, nor the last down", () => {
    const page = loadPage();
    const cards = page.document.querySelectorAll(".source");
    expect(cards[0].querySelector(".move-up").disabled).toBe(true);
    expect(cards[cards.length - 1].querySelector(".move-down").disabled).toBe(true);
  });

  test("a source with no key is skipped entirely", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.setKey("currents", "");
    page.setKey("newsdata", "n1");
    page.check("top");
    page.submit();
    const url = page.document.getElementById("manifest-url").value;
    const segment = url.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).sources).toEqual([{ provider: "newsdata", apiKey: "n1" }]);
  });

  test("keys are trimmed on the way into the URL", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.setKey("currents", "   c1   ");
    page.check("top");
    page.submit();
    const url = page.document.getElementById("manifest-url").value;
    const segment = url.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).sources[0].apiKey).toBe("c1");
  });

  // The badge must show the real failover position, not a row number, or a
  // user with a gap in the list would misread their own priority order.
  test("rank badges count only the sources that are in use", () => {
    const page = loadPage();
    // Card order is the default chain: youtube, newsmcp, currents, newsdata,
    // gnews -- and NewsMCP starts switched on.
    expect(page.ranks()).toEqual(["-", "1", "-", "-", "-"]);
    page.setSwitch("newsmcp", false);
    expect(page.ranks()).toEqual(["-", "-", "-", "-", "-"]);
    page.setKey("newsdata", "n1");
    expect(page.ranks()).toEqual(["-", "-", "-", "1", "-"]);
    page.setKey("gnews", "g1");
    expect(page.ranks()).toEqual(["-", "-", "-", "1", "2"]);
    page.setKey("currents", "c1");
    expect(page.ranks()).toEqual(["-", "-", "1", "2", "3"]);
  });

  test("a filled source is visibly marked as active", () => {
    const page = loadPage();
    const card = page.document.querySelector('.source[data-provider="currents"]');
    expect(card.className).not.toContain("active");
    page.setKey("currents", "c1");
    expect(card.className).toContain("active");
  });

  test("re-configuration shows the saved order back, and regenerates it unchanged", () => {
    const existing = {
      sources: [
        { provider: "gnews", apiKey: "g1" },
        { provider: "currents", apiKey: "c1" }
      ],
      topics: ["top"],
      language: "en"
    };
    const page = loadPage({ existing });
    expect(page.cardOrder().slice(0, 2)).toEqual(["gnews", "currents"]);
    page.submit();
    const url = page.document.getElementById("manifest-url").value;
    const segment = url.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).sources).toEqual(existing.sources);
  });

  test("clicking anywhere that is not a move button does nothing", () => {
    const page = loadPage();
    page.setKey("currents", "c1");
    const before = page.cardOrder();
    page.click(".source-note");
    page.click("#sources-list");
    expect(page.cardOrder()).toEqual(before);
  });
});

describe("configure page — NewsMCP, the source that needs no key", () => {
  test("a new setup starts with it switched on, ranked first in use", () => {
    const page = loadPage();
    expect(page.switchOf("newsmcp").checked).toBe(true);
    expect(page.document.querySelector('.source[data-provider="newsmcp"]').className).toContain("active");
    expect(page.ranks()[1]).toBe("1");
  });

  test("with no keys at all, a new setup still generates a working link", () => {
    const page = loadPage();
    page.check("top");
    page.submit();
    expect(page.document.getElementById("error").style.display).not.toBe("block");
    expect(decodeConfig(page.generated()).sources).toEqual([{ provider: "newsmcp", apiKey: "" }]);
  });

  test("a keyless source is stored without an empty key, keeping the URL short", () => {
    const page = loadPage();
    page.check("top");
    page.submit();
    expect(JSON.parse(decodeURIComponent(page.generated())).sources).toEqual([{ provider: "newsmcp" }]);
  });

  test("switched off, it is left out of the chain", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.setKey("currents", "c1");
    page.check("top");
    page.submit();
    expect(decodeConfig(page.generated()).sources).toEqual([{ provider: "currents", apiKey: "c1" }]);
  });

  test("switched off with no keys, the page names the way out", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.check("top");
    page.submit();
    const error = page.document.getElementById("error");
    expect(error.style.display).toBe("block");
    expect(error.textContent).toBe("Add a key for at least one news source, or turn on NewsMCP.");
  });

  test("it takes its place in the chain alongside keyed sources", () => {
    const page = loadPage();
    page.setKey("youtube", "y1");
    page.setKey("currents", "c1");
    page.check("top");
    page.submit();
    expect(decodeConfig(page.generated()).sources).toEqual([
      { provider: "youtube", apiKey: "y1" },
      { provider: "newsmcp", apiKey: "" },
      { provider: "currents", apiKey: "c1" }
    ]);
  });

  test("an optional key is carried when given", () => {
    const page = loadPage();
    page.setKey("newsmcp", "  nmk_123  ");
    page.check("top");
    page.submit();
    expect(decodeConfig(page.generated()).sources).toEqual([{ provider: "newsmcp", apiKey: "nmk_123" }]);
  });

  test("typing a key into it switches it on", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.typeKey("newsmcp", "nmk_123");
    expect(page.switchOf("newsmcp").checked).toBe(true);
    expect(page.ranks()[1]).toBe("1");
  });

  test("typing into a keyed source leaves the switch alone", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.typeKey("currents", "c1");
    expect(page.switchOf("newsmcp").checked).toBe(false);
  });

  test("clearing its key does not switch it off", () => {
    const page = loadPage();
    page.typeKey("newsmcp", "nmk_123");
    page.typeKey("newsmcp", "");
    expect(page.switchOf("newsmcp").checked).toBe(true);
  });

  test("switched off, a key typed earlier is not carried", () => {
    const page = loadPage();
    page.typeKey("newsmcp", "nmk_123");
    page.setSwitch("newsmcp", false);
    page.setKey("currents", "c1");
    page.check("top");
    page.submit();
    expect(decodeConfig(page.generated()).sources.map((s) => s.provider)).toEqual(["currents"]);
  });

  test("refuses a non-English setup whose only source writes in English", () => {
    const page = loadPage();
    page.check("top");
    page.document.getElementById("language").value = "de";
    page.submit();
    const error = page.document.getElementById("error");
    expect(error.style.display).toBe("block");
    expect(error.textContent).toContain("writes in English");
    expect(page.document.getElementById("result").className).not.toContain("show");
  });

  test("a non-English setup is fine once another source is keyed", () => {
    const page = loadPage();
    page.setKey("newsdata", "n1");
    page.check("top");
    page.document.getElementById("language").value = "de";
    page.submit();
    expect(page.document.getElementById("error").style.display).not.toBe("block");
    expect(decodeConfig(page.generated()).language).toBe("de");
  });

  test("reconfiguring a setup that never had it does not quietly add it", () => {
    const page = loadPage({ existing: { sources: [{ provider: "currents", apiKey: "c1" }], topics: ["top"], language: "en" } });
    expect(page.switchOf("newsmcp").checked).toBe(false);
    page.submit();
    expect(decodeConfig(page.generated()).sources).toEqual([{ provider: "currents", apiKey: "c1" }]);
  });

  test("reconfiguring a keyless setup keeps it on and regenerates it unchanged", () => {
    const existing = {
      sources: [
        { provider: "newsmcp", apiKey: "" },
        { provider: "gnews", apiKey: "g1" }
      ],
      topics: ["top"],
      language: "en"
    };
    const page = loadPage({ existing });
    expect(page.cardOrder().slice(0, 2)).toEqual(["newsmcp", "gnews"]);
    expect(page.switchOf("newsmcp").checked).toBe(true);
    page.submit();
    expect(decodeConfig(page.generated()).sources).toEqual(existing.sources);
  });

  test("reconfiguring a keyed setup shows its key back", () => {
    const page = loadPage({ existing: { sources: [{ provider: "newsmcp", apiKey: "nmk_9" }], topics: ["top"], language: "en" } });
    expect(page.document.querySelector('.source[data-provider="newsmcp"] .source-key').value).toBe("nmk_9");
    expect(page.switchOf("newsmcp").checked).toBe(true);
  });

  test("only NewsMCP has a switch; every other source is keyed", () => {
    const page = loadPage();
    const switched = Array.from(page.document.querySelectorAll(".source-on")).map((box) =>
      box.closest(".source").getAttribute("data-provider")
    );
    expect(switched).toEqual(["newsmcp"]);
  });

  test("none of this raises a script error", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.typeKey("newsmcp", "k");
    page.check("top");
    page.submit();
    expect(page.errors).toEqual([]);
  });
});

describe("configure page — building the catalog list", () => {
  test("starts empty and says so", () => {
    const page = loadPage();
    expect(page.topicRows()).toEqual([]);
    expect(page.document.querySelector(".topic-empty").textContent).toContain("No catalogs yet");
  });

  test("a preset chip adds that topic to the end of the list", () => {
    const page = loadPage();
    page.check("technology");
    page.check("sports");
    expect(page.topicIds()).toEqual(["technology", "sports"]);
  });

  test("an added preset stops being offered as a chip", () => {
    const page = loadPage();
    const before = page.document.querySelectorAll("#preset-chips button").length;
    page.check("technology");
    expect(page.document.querySelectorAll("#preset-chips button").length).toBe(before - 1);
  });

  test("removing a topic puts its chip back", () => {
    const page = loadPage();
    page.check("technology");
    page.rowButton("technology", "remove").dispatchEvent(new page.dom.window.Event("click", { bubbles: true }));
    expect(page.topicIds()).toEqual([]);
    expect(
      Array.from(page.document.querySelectorAll("#preset-chips button")).some((b) => b.textContent === "+ Technology")
    ).toBe(true);
  });

  test("ranks renumber as the list changes", () => {
    const page = loadPage();
    page.check("technology", "sports", "health");
    expect(page.topicRows().map((r) => r.rank)).toEqual(["1", "2", "3"]);
    page.rowButton("sports", "remove").dispatchEvent(new page.dom.window.Event("click", { bubbles: true }));
    expect(page.topicRows().map((r) => r.rank)).toEqual(["1", "2"]);
  });
});

describe("configure page — custom topics", () => {
  const url = (page) => page.document.getElementById("manifest-url").value;
  const segOf = (page) => url(page).slice(BASE.length + 1, -"/manifest.json".length);

  test("typing a topic and pressing Add creates a catalog for it", () => {
    const page = loadPage();
    page.addCustom("London crime");
    expect(page.topicRows()).toEqual([{ id: "q_london-crime", label: "London crimecustom", rank: "1" }]);
  });

  test("a custom topic is marked as custom", () => {
    const page = loadPage();
    page.addCustom("London crime");
    expect(page.document.querySelector(".topic-row .chip").textContent).toBe("custom");
  });

  test("it reaches the config as a query the server can decode", () => {
    const page = loadPage();
    page.setKey("newsdata", "k");
    page.addCustom("London crime");
    page.submit();
    expect(decodeConfig(segOf(page)).topics).toEqual([
      { kind: "custom", id: "q_london-crime", label: "London crime", query: "London crime" }
    ]);
  });

  // Regression: the whitespace collapse was written as a regex inside the
  // page's template literal, which ate the escape and split on the letter
  // "s" instead of on spaces.
  test("collapses runs of whitespace rather than splitting on a letter", () => {
    const page = loadPage();
    page.setKey("newsdata", "k");
    page.addCustom("  sports   scores  ");
    page.submit();
    expect(decodeConfig(segOf(page)).topics[0].query).toBe("sports scores");
  });

  test("the input clears after adding, ready for the next one", () => {
    const page = loadPage();
    page.addCustom("London crime");
    expect(page.document.getElementById("custom-topic").value).toBe("");
  });

  test("Enter in the custom field adds the topic instead of submitting", () => {
    const page = loadPage();
    const input = page.document.getElementById("custom-topic");
    input.value = "Arsenal";
    const ev = new page.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(page.topicIds()).toEqual(["q_arsenal"]);
    expect(ev.defaultPrevented).toBe(true);
  });

  test.each([["   "], [""], ["!!!"], ["--- ---"]])("refuses %p as a topic", (text) => {
    const page = loadPage();
    page.addCustom(text);
    expect(page.topicIds()).toEqual([]);
  });

  test("refuses a duplicate, however it is spelled", () => {
    const page = loadPage();
    page.addCustom("London crime");
    page.addCustom("  London   Crime  ");
    expect(page.topicIds()).toEqual(["q_london-crime"]);
    expect(page.document.getElementById("error").textContent).toContain("already have a catalog");
  });

  test("caps how many custom topics can be added", () => {
    const page = loadPage();
    for (let i = 0; i < 20; i++) page.addCustom(`topic number ${i}`);
    expect(page.topicIds().length).toBe(12);
    expect(page.document.getElementById("error").textContent).toContain("at most 12");
  });

  test("a topic the user typed is never interpreted as markup", () => {
    const page = loadPage();
    page.addCustom('<img src=x onerror="window.PWNED=1">');
    expect(page.dom.window.PWNED).toBeUndefined();
    expect(page.document.querySelectorAll("#topic-list img")).toHaveLength(0);
    expect(page.document.querySelector(".topic-label").textContent).toContain("<img");
  });
});

describe("configure page — catalog order", () => {
  const segOf = (page) =>
    page.document.getElementById("manifest-url").value.slice(BASE.length + 1, -"/manifest.json".length);

  test("moving a topic up changes the order that is generated", () => {
    const page = loadPage();
    page.setKey("newsdata", "k");
    page.check("technology", "sports");
    page.rowButton("sports", "move-up").dispatchEvent(new page.dom.window.Event("click", { bubbles: true }));
    expect(page.topicIds()).toEqual(["sports", "technology"]);
    page.submit();
    expect(decodeConfig(segOf(page)).topics.map((t) => t.id)).toEqual(["sports", "technology"]);
  });

  test("moving a topic down works too", () => {
    const page = loadPage();
    page.check("technology", "sports");
    page.rowButton("technology", "move-down").dispatchEvent(new page.dom.window.Event("click", { bubbles: true }));
    expect(page.topicIds()).toEqual(["sports", "technology"]);
  });

  test("a custom topic can be placed between presets", () => {
    const page = loadPage();
    page.setKey("newsdata", "k");
    page.check("technology");
    page.addCustom("London crime");
    page.check("sports");
    expect(page.topicIds()).toEqual(["technology", "q_london-crime", "sports"]);
    page.submit();
    expect(decodeConfig(segOf(page)).topics.map((t) => t.id)).toEqual([
      "technology",
      "q_london-crime",
      "sports"
    ]);
  });

  test("the first row cannot move up, nor the last down", () => {
    const page = loadPage();
    page.check("technology", "sports");
    expect(page.rowButton("technology", "move-up").disabled).toBe(true);
    expect(page.rowButton("sports", "move-down").disabled).toBe(true);
  });

  test("re-configuration shows the saved order back and regenerates it unchanged", () => {
    const existing = {
      sources: [{ provider: "newsdata", apiKey: "k" }],
      topics: ["sports", { q: "London crime" }, "technology"],
      language: "en"
    };
    const page = loadPage({ existing });
    expect(page.topicIds()).toEqual(["sports", "q_london-crime", "technology"]);
    page.submit();
    expect(decodeConfig(segOf(page)).topics.map((t) => t.id)).toEqual([
      "sports",
      "q_london-crime",
      "technology"
    ]);
  });
});

describe("revealing an API key", () => {
  const toggleFor = (page, provider) =>
    page.document.querySelector(`.source[data-provider="${provider}"] .key-toggle`);
  const fieldFor = (page, provider) =>
    page.document.querySelector(`.source[data-provider="${provider}"] .source-key`);

  test("clicking reveals the key, clicking again hides it", () => {
    const page = loadPage();
    page.setKey("youtube", "AIzaSECRET");
    const field = fieldFor(page, "youtube");
    const toggle = toggleFor(page, "youtube");

    expect(field.type).toBe("password");
    toggle.click();
    expect(field.type).toBe("text");
    expect(field.value).toBe("AIzaSECRET"); // readable, so it can be copied
    toggle.click();
    expect(field.type).toBe("password");
  });

  test("the button reports its state, which is also what swaps the icon", () => {
    // The slash is always in the markup; CSS shows it off aria-pressed, so
    // the icon can never drift out of step with the field.
    const page = loadPage();
    const toggle = toggleFor(page, "youtube");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("title")).toBe("Show key");
    expect(toggle.querySelectorAll("svg")).toHaveLength(1);
    expect(toggle.querySelector(".eye-slash")).not.toBeNull();

    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("title")).toBe("Hide key");
  });

  test("each source's toggle only affects its own field", () => {
    const page = loadPage();
    toggleFor(page, "youtube").click();
    expect(fieldFor(page, "youtube").type).toBe("text");
    expect(fieldFor(page, "currents").type).toBe("password");
    expect(fieldFor(page, "newsdata").type).toBe("password");
  });

  test("revealing a key does not disturb what gets generated", () => {
    const page = loadPage();
    page.setSwitch("newsmcp", false);
    page.setKey("newsdata", "pub_abc");
    toggleFor(page, "newsdata").click();
    page.check("top");
    page.submit();
    const url = page.document.getElementById("manifest-url").value;
    const segment = url.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).sources).toEqual([{ provider: "newsdata", apiKey: "pub_abc" }]);
  });

  test("the page still loads without script errors", () => {
    const page = loadPage();
    toggleFor(page, "youtube").click();
    expect(page.errors).toEqual([]);
  });
});


describe("choosing and ordering the YouTube stream options", () => {
  const rowIds = (page) =>
    [...page.document.querySelectorAll("#yt-options .yt-option")].map((r) => r.getAttribute("data-option"));
  const rowFor = (page, id) => page.document.querySelector(`.yt-option[data-option="${id}"]`);

  const generated = (page) => {
    const url = page.document.getElementById("manifest-url").value;
    return decodeConfig(url.slice(BASE.length + 1, -"/manifest.json".length));
  };

  const fill = (page) => {
    page.setKey("youtube", "AIza-key");
    page.check("top");
  };

  test("the default order and selection are what gets generated", () => {
    const page = loadPage();
    expect(rowIds(page)).toEqual(["app", "youtube", "smarttube"]);
    fill(page);
    page.submit();
    expect(generated(page).youtubeStreams).toEqual(["app", "youtube"]);
  });

  test("turning one on adds it, in its listed position", () => {
    const page = loadPage();
    rowFor(page, "smarttube").querySelector(".yt-option-on").checked = true;
    fill(page);
    page.submit();
    expect(generated(page).youtubeStreams).toEqual(["app", "youtube", "smarttube"]);
  });

  test("turning one off removes it entirely", () => {
    const page = loadPage();
    rowFor(page, "app").querySelector(".yt-option-on").checked = false;
    fill(page);
    page.submit();
    expect(generated(page).youtubeStreams).toEqual(["youtube"]);
  });

  test("moving a row up changes the order that is generated", () => {
    const page = loadPage();
    rowFor(page, "smarttube").querySelector(".yt-up").click();
    rowFor(page, "smarttube").querySelector(".yt-up").click();
    expect(rowIds(page)).toEqual(["smarttube", "app", "youtube"]);

    rowFor(page, "smarttube").querySelector(".yt-option-on").checked = true;
    fill(page);
    page.submit();
    expect(generated(page).youtubeStreams).toEqual(["smarttube", "app", "youtube"]);
  });

  test("moving a row down works too", () => {
    const page = loadPage();
    rowFor(page, "app").querySelector(".yt-down").click();
    expect(rowIds(page)).toEqual(["youtube", "app", "smarttube"]);
  });

  test("the first row cannot move up, nor the last down", () => {
    const page = loadPage();
    const rows = page.document.querySelectorAll("#yt-options .yt-option");
    expect(rows[0].querySelector(".yt-up").disabled).toBe(true);
    expect(rows[0].querySelector(".yt-down").disabled).toBe(false);
    expect(rows[rows.length - 1].querySelector(".yt-down").disabled).toBe(true);
  });

  test("the arrows keep up with the order after a move", () => {
    const page = loadPage();
    rowFor(page, "app").querySelector(".yt-down").click();
    // "app" is no longer first, so it can move up again now.
    expect(rowFor(page, "app").querySelector(".yt-up").disabled).toBe(false);
    expect(rowFor(page, "youtube").querySelector(".yt-up").disabled).toBe(true);
  });

  test("turning everything off falls back rather than generating nothing playable", () => {
    const page = loadPage();
    ["app", "youtube", "smarttube"].forEach((id) => {
      rowFor(page, id).querySelector(".yt-option-on").checked = false;
    });
    fill(page);
    page.submit();
    expect(generated(page).youtubeStreams).toEqual(["app", "youtube"]);
  });

  test("none of this raises a script error", () => {
    const page = loadPage();
    rowFor(page, "smarttube").querySelector(".yt-up").click();
    rowFor(page, "app").querySelector(".yt-down").click();
    expect(page.errors).toEqual([]);
  });
});

describe("configure page — keeping YouTube searches to news", () => {
  const rawConfig = (page) => {
    const url = page.document.getElementById("manifest-url").value;
    return JSON.parse(decodeURIComponent(url.slice(BASE.length + 1, -"/manifest.json".length)));
  };
  const fill = (page) => {
    page.setKey("youtube", "AIza-key");
    page.check("top");
  };
  const newsBox = (page) => page.document.getElementById("yt-news");

  test("left on, it adds nothing to the URL, and the addon reads it as on", () => {
    const page = loadPage();
    expect(newsBox(page).checked).toBe(true);
    fill(page);
    page.submit();
    expect(rawConfig(page)).not.toHaveProperty("youtubeNews");
    expect(decodeConfig(encodeURIComponent(JSON.stringify(rawConfig(page)))).youtubeNews).toBe(true);
  });

  test("switched off, the URL carries youtubeNews: false", () => {
    const page = loadPage();
    newsBox(page).checked = false;
    fill(page);
    page.submit();
    expect(rawConfig(page).youtubeNews).toBe(false);
    expect(decodeConfig(encodeURIComponent(JSON.stringify(rawConfig(page)))).youtubeNews).toBe(false);
  });

  test("reconfiguring keeps it off, and ticking it again takes it out of the URL", () => {
    const existing = {
      sources: [{ provider: "youtube", apiKey: "AIza-key" }],
      topics: ["top"],
      language: "en",
      youtubeNews: false
    };
    const page = loadPage({ existing });
    expect(newsBox(page).checked).toBe(false);
    page.submit();
    expect(rawConfig(page).youtubeNews).toBe(false);

    newsBox(page).checked = true;
    page.submit();
    expect(rawConfig(page)).not.toHaveProperty("youtubeNews");
  });
});
