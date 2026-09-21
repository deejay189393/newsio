const { renderConfigurePage, escapeHtml, orderedProviders, REPO_URL } = require("../src/configurePage");
const { TOPICS, LANGUAGES, PROVIDERS } = require("../src/providers");

const BASE = "https://newsio.up.railway.app";
const checkedBoxes = (html) => (html.match(/\schecked\s\/>/g) || []).length;

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
    expect(orderedProviders(existing).map((p) => p.id)).toEqual(["gnews", "newsdata", "youtube", "currents"]);
  });

  test("unconfigured providers follow, in the default order", () => {
    expect(orderedProviders({ sources: [{ provider: "newsdata", apiKey: "n" }] }).map((p) => p.id)).toEqual([
      "newsdata",
      "youtube",
      "currents",
      "gnews"
    ]);
  });

  test("with nothing saved the default order stands", () => {
    expect(orderedProviders(null).map((p) => p.id)).toEqual(["youtube", "currents", "newsdata", "gnews"]);
    expect(orderedProviders({}).map((p) => p.id)).toEqual(["youtube", "currents", "newsdata", "gnews"]);
  });

  test("an unknown saved provider is ignored rather than crashing the page", () => {
    expect(orderedProviders({ sources: [{ provider: "nope", apiKey: "x" }] }).map((p) => p.id)).toEqual([
      "youtube",
      "currents",
      "newsdata",
      "gnews"
    ]);
  });

  test("the rendered card order matches", () => {
    const existing = { sources: [{ provider: "gnews", apiKey: "g" }], topics: [], language: "en" };
    const markup = renderConfigurePage({ baseUrl: BASE, existing });
    const order = [...markup.matchAll(/data-provider="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["gnews", "youtube", "currents", "newsdata"]);
  });
});


describe("the YouTube playback setting on the page", () => {
  const render = (existing) => renderConfigurePage({ baseUrl: BASE, existing });

  test("defaults to playing in the app", () => {
    const markup = render(null);
    expect(markup).toContain('<option value="app" selected>');
    expect(markup).not.toContain('<option value="youtube" selected>');
  });

  test("a saved preference is shown back on reconfigure", () => {
    const markup = render({ sources: [], topics: [], language: "en", youtubePlayback: "youtube" });
    expect(markup).toContain('<option value="youtube" selected>');
    expect(markup).not.toContain('<option value="app" selected>');
  });

  test("it sits inside the YouTube card, where the key is entered", () => {
    const markup = render(null);
    const youtubeCard = markup.slice(markup.indexOf('data-provider="youtube"'));
    const nextCard = youtubeCard.indexOf('data-provider="', 1);
    expect(youtubeCard.slice(0, nextCard)).toContain('id="youtube-playback"');
  });

  test("only the YouTube card has one", () => {
    expect((render(null).match(/id="youtube-playback"/g) || []).length).toBe(1);
  });
});

describe("API keys can be revealed", () => {
  test("every key field has a show/hide toggle", () => {
    // So a key can be read back and copied when reconfiguring.
    const markup = renderConfigurePage({ baseUrl: BASE, existing: null });
    const providers = (markup.match(/data-provider="/g) || []).length;
    expect((markup.match(/class="key-toggle"/g) || []).length).toBe(providers);
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
