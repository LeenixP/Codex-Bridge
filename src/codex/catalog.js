"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
 * Safely insert or update a key-value pair inside a TOML [section].
 * Uses line-level operations to avoid corrupting the TOML structure.
 */
function upsertTomlKey(content, section, key, value, comment) {
  var lines = content.split("\n");
  var sectionHeader = "[" + section + "]";
  var sectionIdx = -1;
  var sectionEnd = lines.length;
  var commentSuffix = comment ? "  " + comment : "";

  // Find section boundaries
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (t === sectionHeader) {
      sectionIdx = i;
      continue;
    }
    if (sectionIdx !== -1 && i > sectionIdx && /^\[/.test(t) && t !== sectionHeader) {
      sectionEnd = i;
      break;
    }
  }

  if (sectionIdx === -1) {
    // Section not found — append
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(sectionHeader);
    lines.push(key + ' = "' + tomlEscape(value) + '"' + commentSuffix);
    return lines.join("\n");
  }

  // Find existing key
  var keyRe = new RegExp("^" + key.replace(/\./g, "\\.") + "\\s*=");
  for (var k = sectionIdx + 1; k < sectionEnd; k++) {
    if (keyRe.test(lines[k].trim())) {
      lines[k] = key + ' = "' + tomlEscape(value) + '"' + commentSuffix;
      return lines.join("\n");
    }
  }

  // Insert after section header
  lines.splice(sectionIdx + 1, 0, key + ' = "' + tomlEscape(value) + '"' + commentSuffix);
  return lines.join("\n");
}

/** Restore a TOML key to its original value, or remove it if original is empty. */
function restoreTomlKey(content, section, key, origValue) {
  if (origValue === null || origValue === undefined) origValue = "";
  var lines = content.split("\n");
  var sectionHeader = "[" + section + "]";
  var keyRe = new RegExp("^" + key.replace(/\./g, "\\.") + "\\s*=\\s*");
  for (var i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i].trim())) {
      if (origValue !== "") {
        lines[i] = key + " = " + origValue;
      } else {
        lines.splice(i, 1);
      }
      break;
    }
  }
  // Clean up empty section
  if (origValue === "") {
    var secIdx = -1;
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].trim() === sectionHeader) { secIdx = j; break; }
    }
    if (secIdx !== -1) {
      var nextSec = lines.length;
      for (var n = secIdx + 1; n < lines.length; n++) {
        if (/^\[/.test(lines[n].trim())) { nextSec = n; break; }
      }
      var hasContent = false;
      for (var c = secIdx + 1; c < nextSec; c++) {
        if (lines[c].trim() && !lines[c].trim().startsWith("#")) { hasContent = true; break; }
      }
      if (!hasContent) {
        lines.splice(secIdx, nextSec - secIdx);
      }
    }
  }
  return lines.join("\n");
}

async function injectCodexConfig(proxyPort, providers) {
  const result = { ok: false, message: "", configPath: CODEX_CONFIG_FILE, authPath: CODEX_AUTH_FILE };

  if (!fs.existsSync(CODEX_CONFIG_DIR)) {
    fs.mkdirSync(CODEX_CONFIG_DIR, { recursive: true });
  }

  const activeProvider = providers.find((p) => p.active) || providers[0];
  if (!activeProvider) {
    result.message = "No provider to inject.";
    return result;
  }

  const providerId = "codex-switch";
  const modelSlug = sanitizeSlug(activeProvider.name);
  const modelName = "codex-switch-" + modelSlug;

  const marker = "# --- Codex-Switch managed section ---";
  const endMarker = "# --- End Codex-Switch ---";

  // Read existing config
  let existing = "";
  try {
    existing = fs.readFileSync(CODEX_CONFIG_FILE, "utf8");
  } catch {}

  // Remove old managed sections
  const startIdx = existing.indexOf(marker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx !== -1 && endIdx !== -1) {
    existing = existing.slice(0, startIdx) + existing.slice(endIdx + endMarker.length + 1);
  }

  // --- Snapshot original values before modification ---
  function readTomlKey(content, key, section) {
    if (section) {
      const secRe = new RegExp("\\[" + section.replace(/\./g, "\\.") + "\\][\\s\\S]*?(?=\\n\\[|$)", "m");
      const secMatch = content.match(secRe);
      if (!secMatch) return null;
      const re = new RegExp("^" + key.replace(/\./g, "\\.") + "\\s*=\\s*(.+)", "m");
      const m = secMatch[0].match(re);
      return m ? m[1].trim().replace(/^"(.*)"$/, "$1") : null;
    }
    const re = new RegExp("^" + key.replace(/\./g, "\\.") + "\\s*=\\s*" + "(.+)$", "m");
    const m = content.match(re);
    return m ? m[1].trim().replace(/^"(.*)"$/, "$1") : null;
  }

  // Top-level keys
  const origProvider = readTomlKey(existing, "model_provider") || "";
  const origModel = readTomlKey(existing, "model") || "";
  const origAuthMethod = readTomlKey(existing, "preferred_auth_method") || "";
  const origPersonality = readTomlKey(existing, "personality") || "";
  const origReasoningEffort = readTomlKey(existing, "model_reasoning_effort") || "";

  // [windows] section keys
  const origSandbox = readTomlKey(existing, "sandbox", "windows") || "";

  // [features] section keys
  const origFeaturesHooks = readTomlKey(existing, "hooks", "features") || readTomlKey(existing, "codex_hooks", "features") || "";
  const origFeaturesMemories = readTomlKey(existing, "memories", "features") || "";
  const origFeaturesComputer = readTomlKey(existing, "computer", "features") || "";

  const modifications = [];

  // --- Apply Codex-Switch overrides ---

  // 1. model_provider / model
  existing = existing.replace(/^model_provider\s*=\s*.*$\n?/m, "").replace(/^model\s*=\s*.*$\n?/m, "");
  const topLevelBlock = 'model_provider = "' + tomlEscape(providerId) + '"\nmodel = "' + tomlEscape(modelName) + '"\n';
  existing = topLevelBlock + existing.replace(/^\n+/, "");
  modifications.push("model_provider → " + providerId);
  modifications.push("model → " + modelName);

  // 2. preferred_auth_method — comment out if "apikey" (incompatible with hybrid OAuth)
  if (origAuthMethod === "apikey") {
    existing = existing.replace(
      /^preferred_auth_method\s*=\s*"apikey"/m,
      '# preferred_auth_method = "apikey"  # Codex-Switch: commented out — incompatible with hybrid OAuth mode',
    );
    modifications.push("commented out preferred_auth_method=apikey");
  }

  // 3. Sandbox — force unelevated (no approval prompts with proxy)
  if (origSandbox && origSandbox !== "unelevated") {
    existing = upsertTomlKey(existing, "windows", "sandbox", "unelevated", "# Codex-Switch: proxy mode, auto-approve");
    modifications.push("sandbox: " + origSandbox + " → unelevated");
  } else if (!origSandbox) {
    existing = upsertTomlKey(existing, "windows", "sandbox", "unelevated", "# Codex-Switch: proxy mode, auto-approve");
    modifications.push("sandbox: (none) → unelevated");
  }

  // 4. [features] — enable hooks and computer for full Codex compatibility
  existing = upsertTomlKey(existing, "features", "hooks", "true", "# Codex-Switch: enabled for proxy compatibility");
  modifications.push("features.hooks → true");
  existing = upsertTomlKey(existing, "features", "computer", "true", "# Codex-Switch: enabled for proxy compatibility");
  modifications.push("features.computer → true");

  // --- Build managed section ---
  const savedOriginals = [
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

  const aliasLines = ['"' + tomlEscape(modelName) + '" = "' + tomlEscape(activeProvider.model || modelName) + '"'];

  const section = [marker, "# Codex-Switch proxy configuration"]
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

  atomicWriteSync(CODEX_CONFIG_FILE, existing.trimEnd() + "\n\n" + section);

  // Clean up dummy key left by older Codex-Switch versions
  try {
    if (fs.existsSync(CODEX_AUTH_FILE)) {
      const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf8"));
      if (auth.OPENAI_API_KEY === CODEX_PROXY_AUTH_KEY) {
        delete auth.OPENAI_API_KEY;
        if (Object.keys(auth).length === 0) {
          fs.unlinkSync(CODEX_AUTH_FILE);
        } else {
          fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify(auth, null, 2), "utf8");
        }
      }
    }
  } catch {}

  result.ok = true;
  result.message = "Codex config updated (" + modifications.join(", ") + ")";
  return result;
}

function removeCodexConfig() {
  const marker = "# --- Codex-Switch managed section ---";
  const endMarker = "# --- End Codex-Switch ---";

  try {
    let content = fs.readFileSync(CODEX_CONFIG_FILE, "utf8");
    const startIdx = content.indexOf(marker);
    const endIdx = content.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1) {
      const section = content.slice(startIdx, endIdx + endMarker.length);

      // Parse all saved original values from comments
      function readSaved(key) {
        const re = new RegExp("^# original_" + key + ' = "([^"]*)"', "m");
        const m = section.match(re);
        return m ? m[1] : null;
      }

      const origProvider = readSaved("provider");
      const origModel = readSaved("model");
      const origAuthMethod = readSaved("auth_method");
      const origSandbox = readSaved("sandbox");
      const origPersonality = readSaved("personality");
      const origReasoningEffort = readSaved("reasoning_effort");
      const origFeaturesHooks = readSaved("features_hooks");
      const origFeaturesMemories = readSaved("features_memories");
      const origFeaturesComputer = readSaved("features_computer");

      // Remove managed section
      content = content.slice(0, startIdx) + content.slice(endIdx + endMarker.length + 1);

      // --- Restore original values ---

      // model_provider / model
      if (origProvider) {
        content = content.replace(/^model_provider\s*=\s*.*$/m, 'model_provider = "' + tomlEscape(origProvider) + '"');
      } else {
        content = content.replace(/^model_provider\s*=\s*.*$\n?/m, "");
      }
      if (origModel) {
        content = content.replace(/^model\s*=\s*.*$/m, 'model = "' + tomlEscape(origModel) + '"');
      } else {
        content = content.replace(/^model\s*=\s*.*$\n?/m, "");
      }

      // preferred_auth_method — uncomment if it was commented out
      content = content.replace(/^# preferred_auth_method = "([^"]*)" {2}# Codex-Switch:.*$\n?/m, 'preferred_auth_method = "$1"\n');
      if (origAuthMethod === "apikey" && !/^preferred_auth_method\s*=/m.test(content)) {
        content = content.replace(/^(model\s*=.*\n)/m, '$1preferred_auth_method = "apikey"\n');
      }

      // sandbox, features — restore originals safely
      content = restoreTomlKey(content, "windows", "sandbox", origSandbox);
      content = restoreTomlKey(content, "features", "hooks", origFeaturesHooks);
      content = restoreTomlKey(content, "features", "computer", origFeaturesComputer);
      content = restoreTomlKey(content, "features", "memories", origFeaturesMemories);

      // personality — restore original or remove if it was Codex-Switch-added
      if (origPersonality) {
        if (/^personality\s*=/m.test(content)) {
          content = content.replace(/^personality\s*=\s*.*$/m, 'personality = "' + tomlEscape(origPersonality) + '"');
        }
      }

      // model_reasoning_effort — restore original
      if (origReasoningEffort) {
        if (/^model_reasoning_effort\s*=/m.test(content)) {
          content = content.replace(/^model_reasoning_effort\s*=\s*.*$/m, 'model_reasoning_effort = "' + tomlEscape(origReasoningEffort) + '"');
        }
      }

      // Clean up multiple blank lines
      content = content.replace(/\n{3,}/g, "\n\n");

      atomicWriteSync(CODEX_CONFIG_FILE, content.trimEnd() + "\n");
    }
  } catch {}

  // Clean up dummy key that may have been written by an older version
  try {
    const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf8"));
    if (auth.OPENAI_API_KEY === CODEX_PROXY_AUTH_KEY) {
      delete auth.OPENAI_API_KEY;
      if (Object.keys(auth).length === 0) {
        fs.unlinkSync(CODEX_AUTH_FILE);
      } else {
        fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify(auth, null, 2), "utf8");
      }
    }
  } catch {}
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
