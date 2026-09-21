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
    setKey: (v) => {
      document.getElementById("apiKey").value = v;
    },
    check: (...ids) => {
      ids.forEach((id) => {
        document.querySelector(`input[name="topics"][value="${id}"]`).checked = true;
      });
    },
    checkedTopics: () =>
      Array.from(document.querySelectorAll('input[name="topics"]:checked')).map((el) => el.value)
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
    page.setKey("pub_abc123");
    page.check("technology");
    const event = page.submit();
    expect(event.defaultPrevented).toBe(true);
  });

  test("reveals the result box and fills both the install link and the URL", () => {
    const page = loadPage();
    page.setKey("pub_abc123");
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
    page.setKey("pub_abc123");
    page.check("technology", "world");
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);

    expect(decodeConfig(segment)).toEqual({
      apiKey: "pub_abc123",
      topics: ["world", "technology"],
      language: "en"
    });
  });

  test("the install link and the copyable URL describe the same addon", () => {
    const page = loadPage();
    page.setKey("pub_abc123");
    page.check("top");
    page.submit();

    const href = page.document.getElementById("install-link").getAttribute("href");
    const manifestUrl = page.document.getElementById("manifest-url").value;
    expect(href).toBe(manifestUrl.replace(/^https:\/\//, "stremio://"));
  });

  test("carries the chosen language through to the config", () => {
    const page = loadPage();
    page.setKey("pub_abc123");
    page.check("top");
    page.document.getElementById("language").value = "fr";
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).language).toBe("fr");
  });

  test("percent-encodes the config into exactly one path segment", () => {
    const page = loadPage();
    page.setKey("pub abc/123");
    page.check("top");
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);
    expect(segment).not.toContain("/");
    expect(decodeConfig(segment).apiKey).toBe("pub abc/123");
  });
});

describe("configure page — validation", () => {
  test("refuses an empty API key and says so", () => {
    const page = loadPage();
    page.check("technology");
    page.submit();

    const error = page.document.getElementById("error");
    expect(error.style.display).toBe("block");
    expect(error.textContent).toContain("API key");
    expect(page.document.getElementById("result").className).not.toContain("show");
  });

  test("refuses when no topic is selected and says so", () => {
    const page = loadPage();
    page.setKey("pub_abc123");
    page.submit();

    const error = page.document.getElementById("error");
    expect(error.style.display).toBe("block");
    expect(error.textContent).toContain("at least one topic");
    expect(page.document.getElementById("result").className).not.toContain("show");
  });

  test("trims surrounding whitespace from the API key", () => {
    const page = loadPage();
    page.setKey("   pub_abc123   ");
    page.check("top");
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);
    expect(decodeConfig(segment).apiKey).toBe("pub_abc123");
  });

  test("clears a previous error once the form is valid", () => {
    const page = loadPage();
    page.submit();
    expect(page.document.getElementById("error").style.display).toBe("block");

    page.setKey("pub_abc123");
    page.check("top");
    page.submit();
    expect(page.document.getElementById("error").style.display).toBe("none");
    expect(page.document.getElementById("result").className).toContain("show");
  });
});

describe("configure page — topic bulk actions", () => {
  test("Select all checks every topic", () => {
    const page = loadPage();
    page.document.getElementById("select-all").dispatchEvent(
      new page.dom.window.Event("click", { bubbles: true })
    );
    const all = page.document.querySelectorAll('input[name="topics"]');
    expect(page.checkedTopics().length).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });

  test("Clear all unchecks every topic", () => {
    const page = loadPage({ existing: { apiKey: "k", topics: ["top", "world"], language: "en" } });
    expect(page.checkedTopics().length).toBe(2);

    page.document.getElementById("clear-all").dispatchEvent(
      new page.dom.window.Event("click", { bubbles: true })
    );
    expect(page.checkedTopics()).toEqual([]);
  });
});

describe("configure page — re-configuration round trip", () => {
  test("pre-filled settings regenerate the same config when submitted unchanged", () => {
    const existing = { apiKey: "pub_secret123", topics: ["technology", "business"], language: "fr" };
    const page = loadPage({ existing });
    page.submit();

    const manifestUrl = page.document.getElementById("manifest-url").value;
    const segment = manifestUrl.slice(BASE.length + 1, -"/manifest.json".length);
    const decoded = decodeConfig(segment);

    expect(decoded.apiKey).toBe(existing.apiKey);
    expect(decoded.language).toBe(existing.language);
    expect(decoded.topics.sort()).toEqual(["business", "technology"]);
  });
});

describe("configure page — copy button", () => {
  test("falls back to selecting the input when the clipboard API is absent", () => {
    const page = loadPage();
    page.setKey("pub_abc123");
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
    page.setKey("pub_abc123");
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
