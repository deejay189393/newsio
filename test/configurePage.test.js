const { renderConfigurePage, escapeHtml } = require("../src/configurePage");
const { TOPICS, LANGUAGES } = require("../src/topics");

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

  test("leaves the API key field empty and no topic checked", () => {
    expect(html).toContain('id="apiKey"');
    expect(html).toContain('value=""');
    expect(checkedBoxes(html)).toBe(0);
  });

  test("does not show the re-configuration banner", () => {
    expect(html).not.toContain("Editing your current setup");
  });

  test("lists every topic as a checkbox", () => {
    TOPICS.forEach((t) => expect(html).toContain(`value="${t.id}"`));
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

  test("builds the install URL with the SDK's config convention", () => {
    expect(html).toContain("encodeURIComponent(JSON.stringify(");
    expect(html).toContain("/manifest.json");
    expect(html).toContain("stremio://");
  });
});

describe("renderConfigurePage — re-configuration", () => {
  const existing = { apiKey: "pub_secret123", topics: ["technology", "business"], language: "fr" };
  const html = renderConfigurePage({ baseUrl: BASE, existing });

  test("pre-fills the saved API key", () => {
    expect(html).toContain("pub_secret123");
  });

  test("pre-checks exactly the previously selected topics", () => {
    expect(checkedBoxes(html)).toBe(2);
    expect(html).toContain('value="technology" checked');
    expect(html).toContain('value="business" checked');
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
      existing: { apiKey: '"><script>alert(1)</script>', topics: [], language: "en" }
    });
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain("&lt;script&gt;");
  });

  test("handles a config with no topics selected", () => {
    const empty = renderConfigurePage({ baseUrl: BASE, existing: { apiKey: "k", topics: [], language: "en" } });
    expect(checkedBoxes(empty)).toBe(0);
    expect(empty).toContain("Editing your current setup");
  });
});
