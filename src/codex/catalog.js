"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parse: parseToml, stringify: stringifyToml } = require("smol-toml");

const CODEX_CONFIG_DIR = path.join(os.homedir(), ".codex");
const CODEX_CONFIG_FILE = path.join(CODEX_CONFIG_DIR, "config.toml");
const CODEX_AUTH_FILE = path.join(CODEX_CONFIG_DIR, "auth.json");
const CODEX_MODELS_CACHE_FILE = path.join(CODEX_CONFIG_DIR, "models_cache.json");
const CODEX_PROXY_AUTH_KEY = "codex-switch-local";
const CATALOG_TIMEOUT_MS = parseInt(process.env.CODEX_CATALOG_TIMEOUT_MS || "15000", 10);
const BASE_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.2"];

function getCodexConfigDir() {
  return CODEX_CONFIG_DIR;
}

function tomlEscape(str) {
  if (!str) return "";
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function atomicWriteSync(filePath, content) {
  // backup original if it exists
  if (fs.existsSync(filePath)) {
    const backupPath = filePath + ".backup." + Date.now();
    fs.copyFileSync(filePath, backupPath);
    // keep at most 5 recent backups
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const pattern = new RegExp("^" + base.replace(/\./g, "\\.") + "\\.backup\\.\\d+$");
    const backups = fs
      .readdirSync(dir)
      .filter(function (f) {
        return pattern.test(f);
      })
      .sort()
      .reverse();
    for (var i = 5; i < backups.length; i++) {
      fs.unlinkSync(path.join(dir, backups[i]));
    }
  }
  // write to temp file, then atomic rename
  var tmpPath = filePath + ".tmp." + Date.now();
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function findCodexCommand() {
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
  const dirs = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      dirs.push(path.join(localAppData, "Programs", "Codex", "resources"));
    }
  }

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return "codex";
}

function execFileAsync(cmd, args, options) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readNativeCatalog(retries = 2) {
  const command = findCodexCommand();
  const args = ["debug", "models", "--bundled"];
  const invocation =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
      ? { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", "call", command, ...args] }
      : { cmd: command, args };

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const output = await execFileAsync(invocation.cmd, invocation.args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: CATALOG_TIMEOUT_MS,
      });
      return JSON.parse(output.replace(/^\uFEFF/, ""));
    } catch (err) {
      lastError = err;
      if (err.killed || err.code === "ETIMEDOUT") {
        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 4000);
          await sleep(delay);
        }
      } else {
        break;
      }
    }
  }
  const code = (lastError && lastError.code) || "UNKNOWN";
  const msg =
    lastError && lastError.killed
      ? "Codex CLI timed out after " +
        CATALOG_TIMEOUT_MS +
        "ms (" +
        (retries + 1) +
        " attempt(s)). Try setting CODEX_CATALOG_TIMEOUT_MS env var."
      : "Failed to run codex CLI (exit code: " + code + "): " + ((lastError && lastError.message) || "");
  try {
    return readModelsCacheCatalog();
  } catch (cacheErr) {
    throw new Error(msg + " Cache fallback failed: " + cacheErr.message);
  }
}

function readModelsCacheCatalog() {
  const raw = fs.readFileSync(CODEX_MODELS_CACHE_FILE, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error("Invalid Codex models_cache.json shape.");
  }
  return parsed;
}

function findBaseModel(catalog) {
  if (!catalog || !Array.isArray(catalog.models)) return null;
  for (const slug of BASE_MODELS) {
    const found = catalog.models.find((m) => m.slug === slug);
    if (found) return found;
  }
  return catalog.models[0] || null;
}

function buildProxyModelEntry(baseModel, provider, proxyPort) {
  const entry = JSON.parse(JSON.stringify(baseModel));
  entry.slug = "codex-switch-" + sanitizeSlug(provider.name);
  entry.name = provider.name + " (via Codex-Switch)";
  entry.display_name = entry.name;
  entry.description = provider.name + " served through Codex-Switch local proxy.";

  if (entry.api) {
    entry.api.endpoint = "http://127.0.0.1:" + proxyPort + "/v1";
    entry.api.model_id = provider.model || entry.api.model_id;
  } else {
    entry.api = {
      endpoint: "http://127.0.0.1:" + proxyPort + "/v1",
      model_id: provider.model,
    };
  }

  if (entry.available_plans) {
    entry.available_plans = ["free", "plus", "pro", "team", "enterprise", "business"];
  }

  entry.supported_in_api = true;
  entry.visibility = entry.visibility || "list";

  return entry;
}

async function buildCatalog(providers, proxyPort) {
  let nativeCatalog = null;
  try {
    nativeCatalog = await readNativeCatalog();
  } catch (err) {
    return { ok: false, error: "Failed to read Codex catalog: " + err.message, models: [] };
  }

  const baseModel = findBaseModel(nativeCatalog);
  if (!baseModel) {
    return { ok: false, error: "No base model found in Codex catalog.", models: [] };
  }

  const activeProviders = (providers || []).filter((p) => p.name && p.model);
  const models = activeProviders.map((p) => buildProxyModelEntry(baseModel, p, proxyPort));

  return { ok: true, error: null, models, baseModel: baseModel.slug };
}

function writeCatalog(catalog, dataDir) {
  const catalogDir = path.join(dataDir || getCodexConfigDir(), "codex-switch");
  if (!fs.existsSync(catalogDir)) fs.mkdirSync(catalogDir, { recursive: true });
  const catalogPath = path.join(catalogDir, "model-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf8");
  return catalogPath;
}

/**
 * Parse a TOML string into a JS object. Returns an empty object on failure.
 */
function safeParseToml(text) {
  if (!text || !text.trim()) return {};
  try {
    return parseToml(text);
  } catch (_e) {
    return {};
  }
}

/**
 * Get a nested key from a parsed TOML object.
 * "model_provider" → obj.model_provider
 * "windows.sandbox" → obj.windows.sandbox
 */
function getTomlKey(obj, key, section) {
  var val;
  if (section) {
    var sec = obj[section];
    if (sec && typeof sec === "object" && !Array.isArray(sec)) {
      val = sec[key];
      if (val === undefined || val === null) return null;
      if (typeof val === "boolean") return val ? "true" : "false";
      return String(val);
    }
    return null;
  }
  val = obj[key];
  if (val === undefined || val === null) return null;
  if (typeof val === "boolean") return val ? "true" : "false";
  return String(val);
}

/**
 * Ensure a nested section exists in the TOML object.
 */
function ensureSection(obj, section) {
  if (!obj[section] || typeof obj[section] !== "object" || Array.isArray(obj[section])) {
    obj[section] = {};
  }
  return obj[section];
}

async function injectCodexConfig(proxyPort, providers) {
  var result = { ok: false, message: "", configPath: CODEX_CONFIG_FILE, authPath: CODEX_AUTH_FILE };

  if (!fs.existsSync(CODEX_CONFIG_DIR)) {
    fs.mkdirSync(CODEX_CONFIG_DIR, { recursive: true });
  }

  var activeProvider = providers.find(function (p) { return p.active; }) || providers[0];
  if (!activeProvider) {
    result.message = "No provider to inject.";
    return result;
  }

  var providerId = "codex-switch";
  var modelSlug = sanitizeSlug(activeProvider.name);
  var modelName = "codex-switch-" + modelSlug;

  var marker = "# --- Codex-Switch managed section ---";
  var endMarker = "# --- End Codex-Switch ---";

  // Read and parse existing config
  var existing = "";
  try { existing = fs.readFileSync(CODEX_CONFIG_FILE, "utf8"); } catch (_e) {}

  // Remove old managed section
  var startIdx = existing.indexOf(marker);
  var endIdx = existing.indexOf(endMarker);
  if (startIdx !== -1 && endIdx !== -1) {
    existing = existing.slice(0, startIdx) + existing.slice(endIdx + endMarker.length + 1);
  }

  var doc = safeParseToml(existing);

  // Snapshot original values
  var origProvider = getTomlKey(doc, "model_provider") || "";
  var origModel = getTomlKey(doc, "model") || "";
  var origAuthMethod = getTomlKey(doc, "preferred_auth_method") || "";
  var origPersonality = getTomlKey(doc, "personality") || "";
  var origReasoningEffort = getTomlKey(doc, "model_reasoning_effort") || "";
  var origSandbox = getTomlKey(doc, "sandbox", "windows") || "";
  var origFeaturesHooks = getTomlKey(doc, "hooks", "features") || getTomlKey(doc, "codex_hooks", "features") || "";
  var origFeaturesMemories = getTomlKey(doc, "memories", "features") || "";
  var origFeaturesComputer = getTomlKey(doc, "computer", "features") || "";

  var modifications = [];

  // Apply Codex-Switch overrides on the parsed TOML object
  doc.model_provider = providerId;
  doc.model = modelName;
  modifications.push("model_provider → " + providerId);

  if (origAuthMethod === "apikey") {
    doc.preferred_auth_method = undefined;
    modifications.push("commented out preferred_auth_method=apikey");
  }

  var ws = ensureSection(doc, "windows");
  ws.sandbox = "unelevated";
  modifications.push("sandbox → unelevated");

  var feats = ensureSection(doc, "features");
  feats.hooks = true;
  feats.computer = true;
  modifications.push("features: hooks=true, computer=true");

  // Serialize back
  var body = stringifyToml(doc);

  // Handle preferred_auth_method comment-out
  if (origAuthMethod === "apikey") {
    body = body.replace(/^preferred_auth_method\s*=\s*.*\n?/m, "");
    body = body.replace(
      /^(model\s*=\s*.*\n)/m,
      "$1# preferred_auth_method = \"apikey\"  # Codex-Switch: commented out — incompatible with hybrid OAuth mode\n"
    );
  }

  // Build saved originals
  var savedOriginals = [
    '# original_provider = "' + tomlEscape(origProvider) + '"',
    '# original_model = "' + tomlEscape(origModel) + '"',
    origAuthMethod ? '# original_auth_method = "' + tomlEscape(origAuthMethod) + '"' : null,
    origSandbox ? '# original_sandbox = "' + tomlEscape(origSandbox) + '"' : null,
    origPersonality ? '# original_personality = "' + tomlEscape(origPersonality) + '"' : null,
    origReasoningEffort ? '# original_reasoning_effort = "' + tomlEscape(origReasoningEffort) + '"' : null,
    origFeaturesHooks ? '# original_features_hooks = "' + tomlEscape(origFeaturesHooks) + '"' : null,
    origFeaturesMemories ? '# original_features_memories = "' + tomlEscape(origFeaturesMemories) + '"' : null,
    origFeaturesComputer ? '# original_features_computer = "' + tomlEscape(origFeaturesComputer) + '"' : null,
  ].filter(Boolean);

  var aliasLines = [
    '"' + tomlEscape(modelName) + '" = "' + tomlEscape(activeProvider.model || modelName) + '"',
  ];

  var section = [
    marker,
    "# Codex-Switch proxy configuration",
  ]
    .concat(savedOriginals)
    .concat([
      "",
      "[model_providers." + tomlEscape(providerId) + "]",
      'name = "' + tomlEscape(activeProvider.name) + ' (Codex-Switch)"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      'api_key = "' + CODEX_PROXY_AUTH_KEY + '"',
      'base_url = "http://127.0.0.1:' + proxyPort + '/v1"',
      "",
      "[model_providers." + providerId + ".model_aliases]",
    ])
    .concat(aliasLines)
    .concat([endMarker, ""])
    .join("\n");

  atomicWriteSync(CODEX_CONFIG_FILE, body.trimEnd() + "\n\n" + section);

  // Clean up dummy auth key
  try {
    if (fs.existsSync(CODEX_AUTH_FILE)) {
      var auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf8"));
      if (auth.OPENAI_API_KEY === CODEX_PROXY_AUTH_KEY) {
        delete auth.OPENAI_API_KEY;
        if (Object.keys(auth).length === 0) {
          fs.unlinkSync(CODEX_AUTH_FILE);
        } else {
          fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify(auth, null, 2), "utf8");
        }
      }
    }
  } catch (_e) {}

  result.ok = true;
  result.message = "Codex config updated (" + modifications.join(", ") + ")";
  return result;
}

function removeCodexConfig() {
  var marker = "# --- Codex-Switch managed section ---";
  var endMarker = "# --- End Codex-Switch ---";

  try {
    var content = fs.readFileSync(CODEX_CONFIG_FILE, "utf8");
    var startIdx = content.indexOf(marker);
    var endIdx = content.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1) {
      var section = content.slice(startIdx, endIdx + endMarker.length);

      function readSaved(key) {
        var re = new RegExp("^# original_" + key + ' = "([^"]*)"', "m");
        var m = section.match(re);
        return m ? m[1] : null;
      }

      var origProvider = readSaved("provider") || "openai";
      var origModel = readSaved("model") || "";
            var origSandbox = readSaved("sandbox") || "elevated";
      var origPersonality = readSaved("personality");
      var origReasoningEffort = readSaved("reasoning_effort");
      var origFeaturesHooks = readSaved("features_hooks");
      var origFeaturesComputer = readSaved("features_computer");
      var origFeaturesMemories = readSaved("features_memories");

      content = content.slice(0, startIdx) + content.slice(endIdx + endMarker.length + 1);

      // Uncomment preferred_auth_method
      content = content.replace(/^# preferred_auth_method = "([^"]*)" {2}# Codex-Switch:.*$\n?/m, 'preferred_auth_method = "$1"\n');

      // Parse remaining TOML and restore
      var doc = safeParseToml(content);

      doc.model_provider = origProvider;
      if (origModel) doc.model = origModel;

      // Sandbox — always restore, never delete
      ensureSection(doc, "windows").sandbox = origSandbox;

      // Features — restore originals
      if (origFeaturesHooks !== null && origFeaturesHooks !== "") {
        ensureSection(doc, "features").hooks = origFeaturesHooks === "true";
      }
      if (origFeaturesComputer !== null && origFeaturesComputer !== "") {
        ensureSection(doc, "features").computer = origFeaturesComputer === "true";
      }
      if (origFeaturesMemories !== null && origFeaturesMemories !== "") {
        ensureSection(doc, "features").memories = origFeaturesMemories === "true";
      }
      if (origPersonality) doc.personality = origPersonality;
      if (origReasoningEffort) doc.model_reasoning_effort = origReasoningEffort;

      content = stringifyToml(doc);
      content = content.replace(/\n{3,}/g, "\n\n");

      atomicWriteSync(CODEX_CONFIG_FILE, content.trimEnd() + "\n");
    }
  } catch (_e) {}

  // Clean up dummy auth key
  try {
    var auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf8"));
    if (auth.OPENAI_API_KEY === CODEX_PROXY_AUTH_KEY) {
      delete auth.OPENAI_API_KEY;
      if (Object.keys(auth).length === 0) {
        fs.unlinkSync(CODEX_AUTH_FILE);
      } else {
        fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify(auth, null, 2), "utf8");
      }
    }
  } catch (_e) {}
}

function writeCodexAuth() {
  try {
    let auth = {};
    if (fs.existsSync(CODEX_AUTH_FILE)) {
      auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf8"));
    }
    // Preserve existing API key; only set if missing
    if (!auth.OPENAI_API_KEY) {
      auth.OPENAI_API_KEY = CODEX_PROXY_AUTH_KEY;
    }
    fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify(auth, null, 2), "utf8");
  } catch {
    fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify({ OPENAI_API_KEY: CODEX_PROXY_AUTH_KEY }, null, 2), "utf8");
  }
}

function sanitizeSlug(name) {
  return (name || "provider")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

module.exports = {
  buildCatalog,
  writeCatalog,
  injectCodexConfig,
  removeCodexConfig,
  writeCodexAuth,
  findCodexCommand,
  getCodexConfigDir,
  CODEX_AUTH_FILE,
  CODEX_PROXY_AUTH_KEY,
};
