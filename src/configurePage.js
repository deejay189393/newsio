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

function renderConfigurePage({ baseUrl, existing }) {
  const apiKey = existing?.apiKey || "";
  const selectedTopics = new Set(existing?.topics || []);
  const language = existing?.language || "en";

  const topicCheckboxes = TOPICS.map((t) => {
    const checked = selectedTopics.has(t.id) ? "checked" : "";
    return `
      <label class="topic">
        <input type="checkbox" name="topics" value="${t.id}" ${checked} />
        <span>${escapeHtml(t.label)}</span>
      </label>`;
  }).join("");

  const languageOptions = LANGUAGES.map((l) => {
    const selected = l.code === language ? "selected" : "";
    return `<option value="${l.code}" ${selected}>${escapeHtml(l.label)}</option>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Newsio — Configure</title>
<style>
  :root {
    --bg: #0f1115;
    --card: #171a21;
    --border: #2a2e38;
    --text: #eef0f4;
    --muted: #9aa1ae;
    --accent: #6c5ce7;
    --accent-2: #8e7bff;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .wrap {
    max-width: 640px;
    margin: 0 auto;
    padding: 32px 20px 60px;
  }
  header { text-align: center; margin-bottom: 28px; }
  header h1 { font-size: 22px; margin: 0 0 6px; }
  header p { color: var(--muted); margin: 0; font-size: 14px; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px;
    margin-bottom: 18px;
  }
  .card h2 { font-size: 15px; margin: 0 0 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  label.field { display: block; margin-bottom: 14px; }
  label.field span.label-text { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input[type="password"], input[type="text"], select {
    width: 100%;
    background: #0d0f14;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 11px 12px;
    border-radius: 9px;
    font-size: 15px;
  }
  input:focus, select:focus { outline: 2px solid var(--accent-2); }
  .topics-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  @media (max-width: 420px) {
    .topics-grid { grid-template-columns: 1fr; }
  }
  label.topic {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #0d0f14;
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 10px 12px;
    font-size: 14px;
    cursor: pointer;
  }
  label.topic input { width: 17px; height: 17px; accent-color: var(--accent); }
  .hint { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
  .hint a { color: var(--accent-2); }
  button {
    width: 100%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white;
    border: none;
    padding: 14px;
    border-radius: 10px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #result {
    margin-top: 18px;
    display: none;
  }
  #result.show { display: block; }
  .result-box {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px;
  }
  .result-box a.install-btn {
    display: block;
    text-align: center;
    text-decoration: none;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white;
    padding: 14px;
    border-radius: 10px;
    font-weight: 600;
    margin-bottom: 10px;
  }
  .url-row {
    display: flex;
    gap: 8px;
  }
  .url-row input {
    font-size: 12px;
    color: var(--muted);
  }
  .url-row button {
    width: auto;
    padding: 10px 14px;
    font-size: 13px;
  }
  .error { color: #ff6b6b; font-size: 13px; margin-top: 10px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>📰 Newsio</h1>
    <p>Pick your topics, add your API key, and install into Stremio.</p>
    <p class="hint" style="margin-top:6px">Descriptions starting with <strong>[VIDEO]</strong> have an actual video to play — everything else opens the article in your browser.</p>
  </header>

  <form id="config-form">
    <div class="card">
      <h2>API Key</h2>
      <label class="field">
        <span class="label-text">newsdata.io API key</span>
        <input type="password" id="apiKey" name="apiKey" placeholder="pub_xxxxxxxxxxxxxxxxxxxx" value="${escapeHtml(apiKey)}" required />
      </label>
      <div class="hint">Get a free key at <a href="https://newsdata.io/register" target="_blank" rel="noopener">newsdata.io/register</a>. It's stored only inside your personal addon URL — never on a server.</div>
    </div>

    <div class="card">
      <h2>Language</h2>
      <label class="field">
        <span class="label-text">Article language</span>
        <select id="language" name="language">
          ${languageOptions}
        </select>
      </label>
    </div>

    <div class="card">
      <h2>Topics (each becomes its own catalog)</h2>
      <div class="topics-grid">
        ${topicCheckboxes}
      </div>
      <div class="hint">Select at least one topic.</div>
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
      <div class="hint">If the button above doesn't open Stremio, paste the copied URL into Stremio's "Add addon" search bar.</div>
    </div>
  </div>
</div>

<script>
  const BASE_URL = ${JSON.stringify(baseUrl)};

  const form = document.getElementById("config-form");
  const errorEl = document.getElementById("error");
  const resultEl = document.getElementById("result");
  const installLink = document.getElementById("install-link");
  const manifestUrlInput = document.getElementById("manifest-url");
  const copyBtn = document.getElementById("copy-btn");

  function base64UrlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    errorEl.style.display = "none";

    const apiKey = document.getElementById("apiKey").value.trim();
    const language = document.getElementById("language").value;
    const topics = Array.from(form.querySelectorAll('input[name="topics"]:checked')).map((el) => el.value);

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

    const configStr = base64UrlEncode(JSON.stringify({ apiKey, topics, language }));
    const httpUrl = BASE_URL.replace(/\\/$/, "") + "/" + configStr + "/manifest.json";
    const stremioUrl = httpUrl.replace(/^https?:\\/\\//, "stremio://");

    installLink.href = stremioUrl;
    manifestUrlInput.value = httpUrl;
    resultEl.classList.add("show");
    resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(manifestUrlInput.value);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    } catch (_) {
      manifestUrlInput.select();
    }
  });
</script>
</body>
</html>`;
}

module.exports = { renderConfigurePage };
