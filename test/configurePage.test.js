const { renderConfigurePage, escapeHtml, orderedProviders, REPO_URL } = require("../src/configurePage");
const { TOPICS, LANGUAGES, PROVIDERS } = require("../src/providers");

const BASE = "https://newsio.up.railway.app";
// Topic checkboxes only. The YouTube stream options are checkboxes too and
// are ticked by default, so counting every box would conflate the two.
const checkedBoxes = (html) => {
  const topics = html.slice(html.indexOf('id="preset-chips"'));
  return (topics.match(/\schecked\s\/>/g) || []).length;
};

describe("escapeHtml", () => {
  test("escapes every HTML-significant character", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
  test("coerces non-strings safely", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("renderConfigurePage — first-time configuration", () => {
  const html = renderConfigurePage({ baseUrl: BASE, existing: null });

  test("renders a complete HTML document", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Newsio");
    expect(html.trim().endsWith("</html>")).toBe(true);
  });

  test("offers every provider, with all key fields empty and no topic checked", () => {
    PROVIDERS.forEach((p) => expect(html).toContain(`data-provider="${p.id}"`));
    expect((html.match(/class="source-key"/g) || [])).toHaveLength(PROVIDERS.length);
    expect(checkedBoxes(html)).toBe(0);
  });

  test("explains that the order is the failover order", () => {
    expect(html).toContain("top to bottom");
    expect(html).toContain("failover chain");
  });

  test("each source carries its own signup link and trade-offs", () => {
    PROVIDERS.forEach((p) => {
      expect(html).toContain(p.signupUrl);
      expect(html).toContain(escapeHtml(p.notes));
    });
  });

  test("warns about the delayed source where the choice is made", () => {
    expect(html).toContain("12h delay");
  });

  test("does not show the re-configuration banner", () => {
    expect(html).not.toContain("Editing your current setup");
  });

  test("ships the preset list and an empty selection to the page script", () => {
    const { PRESET_TOPICS } = require("../src/topics");
    PRESET_TOPICS.forEach((t) => expect(html).toContain(JSON.stringify(t.label)));
    expect(html).toContain("var TOPICS = [];");
  });

  test("offers the controls for building an ordered catalog list", () => {
    expect(html).toContain('id="topic-list"');
    expect(html).toContain('id="preset-chips"');
    expect(html).toContain('id="custom-topic"');
    expect(html).toContain('id="add-custom"');
  });

  test("explains that the order is the catalog order", () => {
    expect(html).toContain("in this order");
  });

  // The example a user is shown is the one most will reach for first, so it
  // should read as an ordinary interest rather than a loaded one.
  test("suggests a neutral example, in both the placeholder and the hint", () => {
    expect(html).toContain('placeholder="FIFA World Cup"');
    expect(html).toContain('"FIFA World Cup", "Arsenal FC", "semiconductor exports"');
  });

  // "Arsenal" alone ranks stock-market stories about Ameresco above football
  // on at least one provider; the disambiguated form searches far better.
  test("suggests the disambiguated club name, not the bare word", () => {
    expect(html).toContain("Arsenal FC");
    expect(html).not.toMatch(/"Arsenal"/);
  });

  test("suggests nothing with a negative connotation", () => {
    expect(html).not.toMatch(/placeholder="[^"]*crime/i);
    expect(html.toLowerCase()).not.toContain("london crime");
  });

  test("each key field is labelled once, without a doubled word", () => {
    PROVIDERS.forEach((p) => expect(html).toContain(`aria-label="${escapeHtml(p.label)} key"`));
    expect(html).not.toContain("API API key");
  });

  test("lists every supported language", () => {
    LANGUAGES.forEach((l) => expect(html).toContain(`value="${l.code}"`));
  });

  test("defaults the language select to English", () => {
    expect(html).toContain('value="en" selected');
  });

  test("embeds the base URL for client-side install-link construction", () => {
    expect(html).toContain(JSON.stringify(BASE));
  });

  test("links to newsdata.io signup so a new user can obtain a key", () => {
    expect(html).toContain("https://newsdata.io/register");
  });

  test("shows the addon tagline, matching the manifest description", () => {
    const { DESCRIPTION } = require("../src/manifest");
    expect(html).toContain(DESCRIPTION);
  });

  test("uses the newspaper logo for both the header art and the favicon", () => {
    expect(html).toContain('<img src="/logo.png"');
    expect(html).toContain('<link rel="icon" href="/logo.png"');
  });

  test("builds the install URL with the SDK's config convention", () => {
    expect(html).toContain("encodeURIComponent(JSON.stringify(");
    expect(html).toContain("/manifest.json");
    expect(html).toContain("stremio://");
  });
});

describe("renderConfigurePage — re-configuration", () => {
  const existing = {
    sources: [
      { provider: "newsdata", apiKey: "pub_secret123" },
      { provider: "currents", apiKey: "cur_abc" }
    ],
    topics: ["technology", "business"],
    language: "fr"
  };
  const html = renderConfigurePage({ baseUrl: BASE, existing });

  test("pre-fills every saved API key", () => {
    expect(html).toContain("pub_secret123");
  });

  test("ships the saved topics, in order, to the page script", () => {
    expect(html).toMatch(/var TOPICS = \[\{"kind":"preset","id":"technology"/);
    expect(html).toContain('"id":"business"');
  });

  test("pre-selects the saved language", () => {
    expect(html).toContain('value="fr" selected');
  });

  test("shows the re-configuration banner", () => {
    expect(html).toContain("Editing your current setup");
  });

  test("escapes a hostile API key rather than injecting script", () => {
    const evil = renderConfigurePage({
      baseUrl: BASE,
      existing: {
        sources: [{ provider: "newsdata", apiKey: '"><script>alert(1)</script>' }],
        topics: [],
        language: "en"
      }
    });
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain("&lt;script&gt;");
  });

  test("handles a config with no topics selected", () => {
    const empty = renderConfigurePage({
      baseUrl: BASE,
      existing: { sources: [{ provider: "currents", apiKey: "k" }], topics: [], language: "en" }
    });
    expect(empty).toContain("var TOPICS = [];");
    expect(empty).toContain("Editing your current setup");
  });

  test("a custom topic is shipped with its query, not just a label", () => {
    const withCustom = renderConfigurePage({
      baseUrl: BASE,
      existing: { sources: [{ provider: "currents", apiKey: "k" }], topics: [{ q: "London crime" }], language: "en" }
    });
    expect(withCustom).toContain('"kind":"custom"');
    expect(withCustom).toContain('"query":"London crime"');
  });
});

describe("orderedProviders — the saved failover order is shown back", () => {
  test("saved sources come first, in their order", () => {
    const existing = { sources: [{ provider: "gnews", apiKey: "g" }, { provider: "newsdata", apiKey: "n" }] };
    expect(orderedProviders(existing).map((p) => p.id)).toEqual(["gnews", "newsdata", "youtube", "newsmcp", "currents"]);
  });

  test("unconfigured providers follow, in the default order", () => {
    expect(orderedProviders({ sources: [{ provider: "newsdata", apiKey: "n" }] }).map((p) => p.id)).toEqual([
      "newsdata",
      "youtube",
      "newsmcp",
      "currents",
      "gnews"
    ]);
  });

  test("with nothing saved the default order stands", () => {
    expect(orderedProviders(null).map((p) => p.id)).toEqual(["youtube", "newsmcp", "currents", "newsdata", "gnews"]);
    expect(orderedProviders({}).map((p) => p.id)).toEqual(["youtube", "newsmcp", "currents", "newsdata", "gnews"]);
  });

  test("an unknown saved provider is ignored rather than crashing the page", () => {
    expect(orderedProviders({ sources: [{ provider: "nope", apiKey: "x" }] }).map((p) => p.id)).toEqual([
      "youtube",
      "newsmcp",
      "currents",
      "newsdata",
      "gnews"
    ]);
  });

  test("the rendered card order matches", () => {
    const existing = { sources: [{ provider: "gnews", apiKey: "g" }], topics: [], language: "en" };
    const markup = renderConfigurePage({ baseUrl: BASE, existing });
    const order = [...markup.matchAll(/data-provider="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["gnews", "youtube", "newsmcp", "currents", "newsdata"]);
  });
});


describe("the NewsMCP card", () => {
  const render = (existing) => renderConfigurePage({ baseUrl: BASE, existing });
  const card = (markup) => {
    const start = markup.indexOf('data-provider="newsmcp"');
    return markup.slice(start, markup.indexOf('<div class="source"', start + 1));
  };

  test("says plainly that it needs no key", () => {
    const markup = card(render(null));
    expect(markup).toContain('<span class="chip">no key needed</span>');
    expect(markup).toContain("Use NewsMCP");
    expect(markup).toContain("Get a free NewsMCP key (optional &mdash; raises the limits)");
  });

  test("starts switched on for a new setup", () => {
    expect(card(render(null))).toContain('class="source-on" checked');
  });

  test("starts switched off when reconfiguring a setup that did not use it", () => {
    const markup = card(render({ sources: [{ provider: "gnews", apiKey: "g" }], topics: [], language: "en" }));
    expect(markup).toContain('class="source-on"');
    expect(markup).not.toContain('class="source-on" checked');
  });

  test("keyed sources keep their plain key link and no switch", () => {
    const markup = render(null);
    const gnews = markup.slice(markup.indexOf('data-provider="gnews"'));
    expect(gnews).toContain("Get a free GNews key</a>");
    expect(gnews.slice(0, gnews.indexOf("source-links"))).not.toContain("source-on");
  });

  test("the lead names the keyless source and the header lists every source", () => {
    const markup = render(null);
    expect(markup).toContain("NewsMCP needs no key, so it is on from the start");
    expect(markup).toContain("Leave a key blank to skip that source, or switch\n        NewsMCP off to skip it.");
    expect(markup).toContain("Reads live headlines from YouTube, NewsMCP, Currents, newsdata.io and GNews.");
  });

  test("the page script knows which sources write English only", () => {
    expect(render(null)).toContain('var ENGLISH_ONLY = ["newsmcp"];');
  });
});

describe("the YouTube stream options on the page", () => {
  const render = (existing) => renderConfigurePage({ baseUrl: BASE, existing });
  const rows = (markup) => [...markup.matchAll(/data-option="([a-z]+)"/g)].map((m) => m[1]);

  test("all three are listed, each with a toggle", () => {
    const markup = render(null);
    expect(rows(markup)).toEqual(["app", "youtube", "smarttube"]);
    expect((markup.match(/class="yt-option-on"/g) || []).length).toBe(3);
  });

  test("by default the first two are ticked and SmartTube is not", () => {
    const markup = render(null);
    expect((markup.match(/class="yt-option-on" checked/g) || []).length).toBe(2);
    const smarttube = markup.slice(markup.indexOf('data-option="smarttube"'));
    expect(smarttube.slice(0, smarttube.indexOf("</li>"))).not.toContain("checked");
  });

  test("a saved order is shown back, enabled first", () => {
    const markup = render({
      sources: [],
      topics: [],
      language: "en",
      youtubeStreams: ["smarttube", "app"]
    });
    // Chosen ones in their order, then whatever was turned off.
    expect(rows(markup)).toEqual(["smarttube", "app", "youtube"]);
  });

  test("a disabled option is still listed, so it can be turned back on", () => {
    const markup = render({ sources: [], topics: [], language: "en", youtubeStreams: ["app"] });
    expect(rows(markup)).toHaveLength(3);
    expect((markup.match(/class="yt-option-on" checked/g) || []).length).toBe(1);
  });

  test("a legacy single-choice config is shown back migrated", () => {
    const markup = render({ sources: [], topics: [], language: "en", youtubePlayback: "youtube" });
    expect(rows(markup)).toEqual(["youtube", "app", "smarttube"]);
  });

  test("every row can be moved", () => {
    const markup = render(null);
    expect((markup.match(/class="yt-up"/g) || []).length).toBe(3);
    expect((markup.match(/class="yt-down"/g) || []).length).toBe(3);
  });

  test("the labels read as intended", () => {
    const markup = render(null);
    expect(markup).toContain("Play in-app");
    expect(markup).toContain("Open in the YouTube app");
    expect(markup).toContain("Open in the SmartTube app");
  });

  test("it sits inside the YouTube card, where the key is entered", () => {
    const markup = render(null);
    const youtubeCard = markup.slice(markup.indexOf('data-provider="youtube"'));
    const nextCard = youtubeCard.indexOf('data-provider="', 1);
    expect(youtubeCard.slice(0, nextCard)).toContain('id="yt-options"');
  });

  test("only the YouTube card has one", () => {
    expect((render(null).match(/id="yt-options"/g) || []).length).toBe(1);
  });
});

describe("API keys can be revealed", () => {
  test("every key field has a show/hide toggle", () => {
    // So a key can be read back and copied when reconfiguring.
    const markup = renderConfigurePage({ baseUrl: BASE, existing: null });
    const providers = (markup.match(/data-provider="/g) || []).length;
    expect((markup.match(/class="key-toggle"/g) || []).length).toBe(providers);
  });

  test("the control is a plain drawn icon, not an emoji", () => {
    // An emoji renders as a coloured sticker at whatever size the platform
    // font decides; an inline SVG inherits the button's colour and size.
    const markup = renderConfigurePage({ baseUrl: BASE, existing: null });
    expect(markup).not.toContain("&#128065;");
    expect(markup).toContain('stroke="currentColor"');
  });

  test("it is one icon of three strokes, not a pair that swaps", () => {
    // Kept deliberately plain: an outline, a pupil and a slash. The shape
    // never morphs between states, so there is nothing to keep in sync.
    const markup = renderConfigurePage({ baseUrl: BASE, existing: null });
    const button = markup.slice(markup.indexOf('class="key-toggle"'));
    const first = button.slice(0, button.indexOf("</button>"));
    expect((first.match(/<svg/g) || []).length).toBe(1);
    expect((first.match(/<path|<circle|<line/g) || []).length).toBe(3);
    expect(first).toContain('class="eye-slash"');
  });

  test("the field still starts masked", () => {
    const markup = renderConfigurePage({ baseUrl: BASE, existing: null });
    expect(markup).toContain('type="password" class="source-key"');
    expect(markup).toContain('aria-pressed="false"');
  });

  test("a saved key is present in the field so it can be copied", () => {
    const markup = renderConfigurePage({
      baseUrl: BASE,
      existing: { sources: [{ provider: "youtube", apiKey: "AIzaSECRET" }], topics: [], language: "en" }
    });
    expect(markup).toContain('value="AIzaSECRET"');
  });
});

describe("the source is easy to find", () => {
  test("the page links to the GitHub repository", () => {
    const markup = renderConfigurePage({ baseUrl: BASE, existing: null });
    expect(markup).toContain(`href="${REPO_URL}"`);
    expect(markup).toContain("Source code on GitHub");
  });

  test("the link opens in a new tab, without handing over the opener", () => {
    const markup = renderConfigurePage({ baseUrl: BASE, existing: null });
    const footer = markup.slice(markup.indexOf("<footer>"), markup.indexOf("</footer>"));
    expect(footer).toContain('target="_blank"');
    expect(footer).toContain('rel="noopener"');
  });

  test("it is there when reconfiguring too", () => {
    const markup = renderConfigurePage({
      baseUrl: BASE,
      existing: { sources: [], topics: [], language: "en" }
    });
    expect(markup).toContain(REPO_URL);
  });

  test("the URL is the real repository", () => {
    expect(REPO_URL).toBe("https://github.com/deejay189393/newsio");
  });
});
