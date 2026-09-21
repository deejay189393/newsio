const { LANGUAGES, PROVIDERS } = require("./providers");
const { PRESET_TOPICS, normalizeTopics, MAX_CUSTOM_TOPICS, MAX_QUERY_LENGTH } = require("./topics");

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
 * Order the provider cards the way the user last saved them, with any they
 * have not configured following behind. Re-configuration has to show the
 * failover order back, since the order *is* the setting.
 */
function orderedProviders(existing) {
  const saved = ((existing && existing.sources) || [])
    .map((s) => PROVIDERS.find((p) => p.id === s.provider))
    .filter(Boolean);
  const rest = PROVIDERS.filter((p) => !saved.includes(p));
  return [...saved, ...rest];
}

/**
 * The addon's own configuration page.
 *
 * Also used as the RE-configuration page: Stremio's "Configure" button on
 * an installed addon opens /<config>/configure, and passing the decoded
 * `existing` config here pre-fills the keys, their order, the language and
 * the topic checkboxes so the user edits their current setup rather than
 * starting over.
 */
function renderConfigurePage({ baseUrl, existing }) {
  const selectedTopics = normalizeTopics((existing && existing.topics) || []);
  const language = (existing && existing.language) || "en";
  const isReconfigure = Boolean(existing);
  const savedKeys = new Map(((existing && existing.sources) || []).map((s) => [s.provider, s.apiKey]));

  const sourceCards = orderedProviders(existing)
    .map((provider) => {
      const key = savedKeys.get(provider.id) || "";
      return `
      <div class="source" data-provider="${escapeHtml(provider.id)}">
        <div class="source-head">
          <div class="source-rank" aria-hidden="true"></div>
          <div class="source-name">
            ${escapeHtml(provider.label)}
            ${provider.delayed ? '<span class="chip warn">12h delay</span>' : ""}
            ${provider.supportsVideo ? '<span class="chip">video</span>' : ""}
          </div>
          <div class="source-move">
            <button type="button" class="move-up" title="Try this source earlier" aria-label="Move ${escapeHtml(provider.label)} earlier">&#9650;</button>
            <button type="button" class="move-down" title="Try this source later" aria-label="Move ${escapeHtml(provider.label)} later">&#9660;</button>
          </div>
        </div>
        <p class="source-note">${escapeHtml(provider.notes)}</p>
        <input type="password" class="source-key" placeholder="${escapeHtml(provider.keyPlaceholder)}" value="${escapeHtml(key)}" aria-label="${escapeHtml(provider.label)} key" />
        <div class="source-links"><a href="${escapeHtml(provider.signupUrl)}" target="_blank" rel="noopener">Get a free ${escapeHtml(provider.label)} key</a></div>
      </div>`;
    })
    .join("");

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
  .card h2 { font-size: 15px; margin: 0 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .card .lead { font-size: 13px; color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
  label.field { display: block; margin-bottom: 14px; }
  label.field span.label-text { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input[type="password"], input[type="text"], select {
    width: 100%; background: #0d0f14; border: 1px solid var(--border); color: var(--text);
    padding: 11px 12px; border-radius: 9px; font-size: 15px;
  }
  input:focus, select:focus { outline: 2px solid var(--accent-2); }
  .source { background: #0d0f14; border: 1px solid var(--border); border-radius: 11px; padding: 14px; margin-bottom: 10px; }
  .source.active { border-color: var(--accent); }
  .source-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .source-rank {
    flex: 0 0 auto; width: 22px; height: 22px; border-radius: 6px; background: var(--border);
    color: var(--text); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center;
  }
  .source.active .source-rank { background: var(--accent); }
  .source-name { flex: 1 1 auto; font-size: 15px; font-weight: 600; }
  .chip {
    display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    padding: 2px 6px; border-radius: 5px; background: rgba(108,92,231,.25); color: var(--accent-2); margin-left: 6px;
    vertical-align: middle;
  }
  .chip.warn { background: rgba(255,176,32,.18); color: #ffb020; }
  .source-move { flex: 0 0 auto; display: flex; gap: 4px; }
  .source-move button {
    width: 28px; height: 28px; padding: 0; font-size: 11px; background: #171a21; border: 1px solid var(--border);
    color: var(--muted); border-radius: 7px; cursor: pointer;
  }
  .source-move button:disabled { opacity: .3; cursor: default; }
  .source-note { font-size: 12px; color: var(--muted); margin: 0 0 10px; line-height: 1.5; }
  .source-links { margin-top: 8px; font-size: 12px; }
  .source-links a { color: var(--accent-2); }
  #topic-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 4px; }
  .topic-row {
    display: flex; align-items: center; gap: 10px; background: #0d0f14; border: 1px solid var(--border);
    border-radius: 9px; padding: 9px 10px; font-size: 14px;
  }
  .topic-rank {
    flex: 0 0 auto; width: 22px; height: 22px; border-radius: 6px; background: var(--accent);
    color: #fff; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center;
  }
  .topic-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .topic-row .btns { flex: 0 0 auto; display: flex; gap: 4px; }
  .topic-row .btns button {
    width: 28px; height: 28px; padding: 0; font-size: 11px; background: #171a21; border: 1px solid var(--border);
    color: var(--muted); border-radius: 7px; cursor: pointer;
  }
  .topic-row .btns button:disabled { opacity: .3; cursor: default; }
  .topic-row .btns button.remove { color: #ff6b6b; }
  .topic-empty { color: var(--muted); font-size: 13px; padding: 12px 2px; }
  .preset-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .preset-chips button {
    width: auto; background: #0d0f14; border: 1px solid var(--border); color: var(--text);
    padding: 7px 11px; font-size: 13px; font-weight: 500; border-radius: 999px; cursor: pointer;
  }
  .preset-chips button:hover { border-color: var(--accent); }
  .add-row { display: flex; gap: 8px; margin-top: 12px; }
  .add-row input { flex: 1 1 auto; }
  .add-row button { width: auto; flex: 0 0 auto; padding: 11px 16px; font-size: 14px; }
  .sub-label { font-size: 12px; color: var(--muted); margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .04em; }
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
    <p>News on Stremio? Why not! Reads live headlines from newsdata.io, Currents and GNews.</p>
  </header>

  ${isReconfigure ? '<div class="banner">Editing your current setup — your keys, their order and your topics are pre-filled. Generate a new link and install it to apply changes.</div>' : ""}

  <form id="config-form">
    <div class="card">
      <h2>News sources</h2>
      <p class="lead">
        Add a key for at least one. Add more than one and they become a failover chain:
        Newsio tries them <strong>top to bottom</strong> and moves to the next whenever one
        is rate-limited or down, so a spent free tier leaves your catalogs full instead of empty.
        Use the arrows to set the order. Leave a key blank to skip that source.
      </p>
      <div id="sources-list">${sourceCards}</div>
      <div class="hint">Every key is free to obtain, and is stored only inside your personal addon URL — never on this server.</div>
    </div>

    <div class="card">
      <h2>Language</h2>
      <label class="field">
        <span class="label-text">Article language</span>
        <select id="language" name="language">${languageOptions}</select>
      </label>
    </div>

    <div class="card">
      <h2>Your catalogs</h2>
      <p class="lead">
        Each one becomes a catalog in Stremio, <strong>in this order</strong> — use the
        arrows to arrange them. Add a preset below, or type anything you like as a
        custom topic: it runs as a standing search and gets a catalog of its own.
      </p>
      <div id="topic-list"></div>
      <div class="sub-label">Add a preset</div>
      <div class="preset-chips" id="preset-chips"></div>
      <div class="sub-label">Add a custom topic</div>
      <div class="add-row">
        <input type="text" id="custom-topic" maxlength="${MAX_QUERY_LENGTH}" placeholder="FIFA World Cup" aria-label="Custom topic" />
        <button type="button" id="add-custom">+ Add</button>
      </div>
      <div class="hint">
        A custom topic is a saved search — "FIFA World Cup", "Arsenal FC", "semiconductor exports".
        Up to ${MAX_CUSTOM_TOPICS} of them. Search is also available as its own catalog covering
        everything, and every catalog pages 20 stories at a time. Not every source carries
        every topic — Newsio simply skips a source that cannot serve one.
      </div>
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
  var PRESETS = ${jsonForScript(PRESET_TOPICS)};
  var MAX_CUSTOM = ${MAX_CUSTOM_TOPICS};
  // The user's catalogs, in order. This array is the source of truth for
  // both the list on screen and the config that gets generated.
  var TOPICS = ${jsonForScript(selectedTopics)};

  var form = document.getElementById("config-form");
  var errorEl = document.getElementById("error");
  var resultEl = document.getElementById("result");
  var installLink = document.getElementById("install-link");
  var manifestUrlInput = document.getElementById("manifest-url");
  var copyBtn = document.getElementById("copy-btn");
  var sourcesList = document.getElementById("sources-list");

  function sourceCards() {
    return Array.prototype.slice.call(sourcesList.querySelectorAll(".source"));
  }

  // The rank badge only counts sources that actually have a key, so the
  // number shown is the real failover position rather than a row number.
  function refreshRanks() {
    var cards = sourceCards();
    var rank = 0;
    cards.forEach(function (card, index) {
      var filled = card.querySelector(".source-key").value.trim().length > 0;
      if (filled) rank++;
      card.className = filled ? "source active" : "source";
      card.querySelector(".source-rank").textContent = filled ? String(rank) : "-";
      card.querySelector(".move-up").disabled = index === 0;
      card.querySelector(".move-down").disabled = index === cards.length - 1;
    });
  }

  sourcesList.addEventListener("click", function (e) {
    var button = e.target.closest ? e.target.closest("button") : null;
    if (!button) return;
    var card = button.closest(".source");
    if (!card) return;
    if (button.className.indexOf("move-up") !== -1 && card.previousElementSibling) {
      sourcesList.insertBefore(card, card.previousElementSibling);
      refreshRanks();
    } else if (button.className.indexOf("move-down") !== -1 && card.nextElementSibling) {
      sourcesList.insertBefore(card.nextElementSibling, card);
      refreshRanks();
    }
  });

  sourcesList.addEventListener("input", refreshRanks);

  var topicList = document.getElementById("topic-list");
  var presetChips = document.getElementById("preset-chips");
  var customInput = document.getElementById("custom-topic");

  function button(text, className, title, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.className = className;
    if (title) { b.title = title; b.setAttribute("aria-label", title); }
    b.addEventListener("click", onClick);
    return b;
  }

  function moveTopic(from, to) {
    if (to < 0 || to >= TOPICS.length) return;
    var moved = TOPICS.splice(from, 1)[0];
    TOPICS.splice(to, 0, moved);
    renderTopics();
  }

  // Built with createElement and textContent rather than markup, so a topic
  // the user typed can never be interpreted as HTML.
  function renderTopics() {
    topicList.textContent = "";

    if (TOPICS.length === 0) {
      var empty = document.createElement("div");
      empty.className = "topic-empty";
      empty.textContent = "No catalogs yet — add at least one below.";
      topicList.appendChild(empty);
    }

    TOPICS.forEach(function (topic, index) {
      var row = document.createElement("div");
      row.className = "topic-row";
      row.setAttribute("data-topic-id", topic.id);

      var rank = document.createElement("div");
      rank.className = "topic-rank";
      rank.textContent = String(index + 1);
      row.appendChild(rank);

      var label = document.createElement("div");
      label.className = "topic-label";
      label.textContent = topic.label;
      row.appendChild(label);

      if (topic.kind === "custom") {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = "custom";
        label.appendChild(chip);
      }

      var btns = document.createElement("div");
      btns.className = "btns";
      var up = button("\u25b2", "move-up", "Move " + topic.label + " up", function () { moveTopic(index, index - 1); });
      var down = button("\u25bc", "move-down", "Move " + topic.label + " down", function () { moveTopic(index, index + 1); });
      up.disabled = index === 0;
      down.disabled = index === TOPICS.length - 1;
      btns.appendChild(up);
      btns.appendChild(down);
      btns.appendChild(button("\u00d7", "remove", "Remove " + topic.label, function () {
        TOPICS.splice(index, 1);
        renderTopics();
      }));
      row.appendChild(btns);
      topicList.appendChild(row);
    });

    renderPresetChips();
  }

  // Only the presets not already chosen are offered, so the chip row is a
  // list of what is still available rather than a set of toggles.
  function renderPresetChips() {
    presetChips.textContent = "";
    var chosen = {};
    TOPICS.forEach(function (t) { chosen[t.id] = true; });

    var remaining = PRESETS.filter(function (p) { return !chosen[p.id]; });
    if (remaining.length === 0) {
      var done = document.createElement("div");
      done.className = "topic-empty";
      done.textContent = "Every preset topic has been added.";
      presetChips.appendChild(done);
      return;
    }

    remaining.forEach(function (preset) {
      presetChips.appendChild(button("+ " + preset.label, "", "Add " + preset.label, function () {
        TOPICS.push({ kind: "preset", id: preset.id, label: preset.label });
        renderTopics();
      }));
    });
  }

  // Character codes rather than a whitespace class: a regex escape written
  // in this block would be eaten by the enclosing template literal and
  // arrive as something else entirely.
  function collapseSpaces(text) {
    var words = [];
    var word = "";
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) <= 32) {
        if (word) { words.push(word); word = ""; }
      } else {
        word += text.charAt(i);
      }
    }
    if (word) words.push(word);
    return words.join(" ");
  }

  function slugify(text) {
    var out = "";
    var lower = text.toLowerCase();
    for (var i = 0; i < lower.length; i++) {
      var c = lower.charAt(i);
      out += (c >= "a" && c <= "z") || (c >= "0" && c <= "9") ? c : "-";
    }
    while (out.indexOf("--") !== -1) out = out.split("--").join("-");
    while (out.charAt(0) === "-") out = out.slice(1);
    while (out.length && out.charAt(out.length - 1) === "-") out = out.slice(0, -1);
    return out;
  }

  function addCustomTopic() {
    errorEl.style.display = "none";
    var query = collapseSpaces(customInput.value);
    if (!query) return;

    var slug = slugify(query);
    if (!slug) {
      showError("That topic has no letters or numbers to search for.");
      return;
    }
    var id = "q_" + slug;
    var clash = TOPICS.filter(function (t) { return t.id === id; }).length > 0;
    if (clash) {
      showError("You already have a catalog for that topic.");
      return;
    }
    if (TOPICS.filter(function (t) { return t.kind === "custom"; }).length >= MAX_CUSTOM) {
      showError("You can have at most " + MAX_CUSTOM + " custom topics.");
      return;
    }

    TOPICS.push({ kind: "custom", id: id, label: query, query: query });
    customInput.value = "";
    renderTopics();
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = "block";
  }

  document.getElementById("add-custom").addEventListener("click", addCustomTopic);
  // Enter in the custom field adds the topic rather than submitting the form.
  customInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); addCustomTopic(); }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.style.display = "none";

    // DOM order is failover order.
    var sources = [];
    sourceCards().forEach(function (card) {
      var apiKey = card.querySelector(".source-key").value.trim();
      if (apiKey) sources.push({ provider: card.getAttribute("data-provider"), apiKey: apiKey });
    });

    var language = document.getElementById("language").value;
    // Order matters: it is the order the catalogs appear in Stremio.
    var topics = TOPICS.map(function (t) {
      return t.kind === "preset" ? t.id : { q: t.query };
    });

    if (sources.length === 0) {
      showError("Please enter an API key for at least one news source.");
      return;
    }
    if (topics.length === 0) {
      showError("Please add at least one catalog.");
      return;
    }

    // Matches stremio-addon-sdk's own config convention exactly:
    // one path segment of encodeURIComponent(JSON.stringify(config)).
    var configSegment = encodeURIComponent(JSON.stringify({ sources: sources, topics: topics, language: language }));
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

  refreshRanks();
  renderTopics();
</script>
</body>
</html>`;
}

module.exports = { renderConfigurePage, escapeHtml, jsonForScript, orderedProviders };
