const { TOPICS, LANGUAGES } = require("./topics");

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

/**
 * Embed a value as a JavaScript literal inside an inline <script>.
 *
 * JSON.stringify on its own is not enough. The HTML parser ends a script at
 * the first literal "</script>" no matter how the JS quoting looks, so a
 * value containing that sequence breaks out and injects markup -- and
 * baseUrl is built from the request's Host header. Escaping "<" closes that,
 * and escaping U+2028/U+2029 covers the two characters that are line
 * terminators to JavaScript but legal raw inside a JSON string.
 */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The addon's own configuration page.
 *
 * Also used as the RE-configuration page: Stremio's "Configure" button on
 * an installed addon opens /<config>/configure, and passing the decoded
 * `existing` config here pre-fills the key, language and topic checkboxes
 * so the user edits their current setup rather than starting over.
 */
function renderConfigurePage({ baseUrl, existing }) {
  const apiKey = (existing && existing.apiKey) || "";
  const selectedTopics = new Set((existing && existing.topics) || []);
  const language = (existing && existing.language) || "en";
  const isReconfigure = Boolean(existing);

  const topicCheckboxes = TOPICS.map((t) => {
    const checked = selectedTopics.has(t.id) ? " checked" : "";
    return `
      <label class="topic">
        <input type="checkbox" name="topics" value="${t.id}"${checked} />
        <span>${escapeHtml(t.label)}</span>
      </label>`;
  }).join("");

  const languageOptions = LANGUAGES.map((l) => {
    const selected = l.code === language ? " selected" : "";
    return `<option value="${l.code}"${selected}>${escapeHtml(l.label)}</option>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Newsio — Configure</title>
<link rel="icon" href="/logo.png" />
<style>
  :root {
    --bg: #0f1115; --card: #171a21; --border: #2a2e38;
    --text: #eef0f4; --muted: #9aa1ae; --accent: #6c5ce7; --accent-2: #8e7bff;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .wrap { max-width: 640px; margin: 0 auto; padding: 32px 20px 60px; }
  header { text-align: center; margin-bottom: 28px; }
  header img { width: 72px; height: 72px; border-radius: 16px; margin-bottom: 12px; }
  header h1 { font-size: 22px; margin: 0 0 6px; }
  header p { color: var(--muted); margin: 0 0 4px; font-size: 14px; }
  .banner {
    background: rgba(108,92,231,.15); border: 1px solid var(--accent);
    border-radius: 10px; padding: 10px 12px; font-size: 13px; margin-bottom: 18px;
  }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px; margin-bottom: 18px; }
  .card h2 { font-size: 15px; margin: 0 0 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  label.field { display: block; margin-bottom: 14px; }
  label.field span.label-text { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input[type="password"], input[type="text"], select {
    width: 100%; background: #0d0f14; border: 1px solid var(--border); color: var(--text);
    padding: 11px 12px; border-radius: 9px; font-size: 15px;
  }
  input:focus, select:focus { outline: 2px solid var(--accent-2); }
  .topics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  @media (max-width: 420px) { .topics-grid { grid-template-columns: 1fr; } }
  label.topic {
    display: flex; align-items: center; gap: 10px; background: #0d0f14; border: 1px solid var(--border);
    border-radius: 9px; padding: 10px 12px; font-size: 14px; cursor: pointer;
  }
  label.topic input { width: 17px; height: 17px; accent-color: var(--accent); }
  .topic-actions { display: flex; gap: 8px; margin-bottom: 10px; }
  .topic-actions button {
    width: auto; flex: 0 0 auto; background: #0d0f14; border: 1px solid var(--border);
    color: var(--muted); padding: 6px 12px; font-size: 12px; font-weight: 500; border-radius: 8px;
  }
  .hint { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
  .hint a { color: var(--accent-2); }
  button {
    width: 100%; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: white; border: none;
    padding: 14px; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer;
  }
  #result { margin-top: 18px; display: none; }
  #result.show { display: block; }
  .result-box { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
  .result-box a.install-btn {
    display: block; text-align: center; text-decoration: none;
    background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: white; padding: 14px;
    border-radius: 10px; font-weight: 600; margin-bottom: 10px;
  }
  .url-row { display: flex; gap: 8px; }
  .url-row input { font-size: 12px; color: var(--muted); }
  .url-row button { width: auto; padding: 10px 14px; font-size: 13px; }
  .error { color: #ff6b6b; font-size: 13px; margin-top: 10px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img src="/logo.png" alt="Newsio" />
    <h1>Newsio</h1>
    <p>News on Stremio? Why not! Uses the newsdata.io API.</p>
  </header>

  ${isReconfigure ? '<div class="banner">Editing your current setup — your existing key and topics are pre-filled. Generate a new link and install it to apply changes.</div>' : ""}

  <form id="config-form">
    <div class="card">
      <h2>API Key</h2>
      <label class="field">
        <span class="label-text">newsdata.io API key</span>
        <input type="password" id="apiKey" name="apiKey" placeholder="pub_xxxxxxxxxxxxxxxxxxxx" value="${escapeHtml(apiKey)}" required />
      </label>
      <div class="hint">Get a free key at <a href="https://newsdata.io/register" target="_blank" rel="noopener">newsdata.io/register</a>. It is stored only inside your personal addon URL — never on this server.</div>
    </div>

    <div class="card">
      <h2>Language</h2>
      <label class="field">
        <span class="label-text">Article language</span>
        <select id="language" name="language">${languageOptions}</select>
      </label>
    </div>

    <div class="card">
      <h2>Topics — each becomes its own catalog</h2>
      <div class="topic-actions">
        <button type="button" id="select-all">Select all</button>
        <button type="button" id="clear-all">Clear all</button>
      </div>
      <div class="topics-grid">${topicCheckboxes}</div>
      <div class="hint">Pick at least one. Every catalog supports search and infinite scroll inside Stremio.</div>
    </div>

    <button type="submit" id="submit-btn">Generate install link</button>
    <div class="error" id="error" style="display:none"></div>
  </form>

  <div id="result">
    <div class="result-box">
      <a id="install-link" class="install-btn" href="#">Install in Stremio</a>
      <div class="url-row">
        <input id="manifest-url" type="text" readonly />
        <button type="button" id="copy-btn">Copy</button>
      </div>
      <div class="hint">If the button does not open Stremio, paste the copied URL into Stremio's "Add addon" box.</div>
    </div>
  </div>
</div>

<script>
  // NOTE: this script lives inside a JS template literal (see the enclosing
  // backticks), which consumes backslash escapes before the browser ever
  // sees them. A regex literal written here arrives mangled and kills the
  // whole script at parse time -- which silently disables every control on
  // this page. Keep this block backslash-free; use string methods instead.
  // test/configurePage.dom.test.js executes this script and enforces that.
  var BASE_URL = ${jsonForScript(baseUrl)};

  var form = document.getElementById("config-form");
  var errorEl = document.getElementById("error");
  var resultEl = document.getElementById("result");
  var installLink = document.getElementById("install-link");
  var manifestUrlInput = document.getElementById("manifest-url");
  var copyBtn = document.getElementById("copy-btn");

  document.getElementById("select-all").addEventListener("click", function () {
    form.querySelectorAll('input[name="topics"]').forEach(function (el) { el.checked = true; });
  });
  document.getElementById("clear-all").addEventListener("click", function () {
    form.querySelectorAll('input[name="topics"]').forEach(function (el) { el.checked = false; });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.style.display = "none";

    var apiKey = document.getElementById("apiKey").value.trim();
    var language = document.getElementById("language").value;
    var topics = Array.prototype.slice
      .call(form.querySelectorAll('input[name="topics"]:checked'))
      .map(function (el) { return el.value; });

    if (!apiKey) {
      errorEl.textContent = "Please enter your newsdata.io API key.";
      errorEl.style.display = "block";
      return;
    }
    if (topics.length === 0) {
      errorEl.textContent = "Please select at least one topic.";
      errorEl.style.display = "block";
      return;
    }

    // Matches stremio-addon-sdk's own config convention exactly:
    // one path segment of encodeURIComponent(JSON.stringify(config)).
    var configSegment = encodeURIComponent(JSON.stringify({ apiKey: apiKey, topics: topics, language: language }));
    var base = BASE_URL;
    while (base.length && base.charAt(base.length - 1) === "/") base = base.slice(0, -1);
    var httpUrl = base + "/" + configSegment + "/manifest.json";
    var schemeEnd = httpUrl.indexOf("://");
    var stremioUrl = schemeEnd === -1 ? httpUrl : "stremio://" + httpUrl.slice(schemeEnd + 3);

    installLink.href = stremioUrl;
    manifestUrlInput.value = httpUrl;
    resultEl.classList.add("show");
    if (resultEl.scrollIntoView) resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  copyBtn.addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(manifestUrlInput.value).then(function () {
        copyBtn.textContent = "Copied!";
        setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
      }).catch(function () { manifestUrlInput.select(); });
    } else {
      manifestUrlInput.select();
    }
  });
</script>
</body>
</html>`;
}

module.exports = { renderConfigurePage, escapeHtml, jsonForScript };
