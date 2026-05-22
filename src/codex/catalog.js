"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEX_CONFIG_DIR = path.join(os.homedir(), ".codex");
const CODEX_CONFIG_FILE = path.join(CODEX_CONFIG_DIR, "config.toml");
const CODEX_AUTH_FILE = path.join(CODEX_CONFIG_DIR, "auth.json");
const CODEX_PROXY_AUTH_KEY = "codex-switch-local";
const CATALOG_TIMEOUT_MS = 8000;
const BASE_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.2"];

function getCodexConfigDir() {
  return CODEX_CONFIG_DIR;
}

function findCodexCommand() {
  const names = process.platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
    : ["codex"];
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);

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

function readNativeCatalog() {
  const command = findCodexCommand();
  const args = ["debug", "models", "--bundled"];
  const invocation = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
    ? { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", "call", command, ...args] }
    : { cmd: command, args };

  const output = execFileSync(invocation.cmd, invocation.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: CATALOG_TIMEOUT_MS,
  });

  return JSON.parse(output.replace(/^﻿/, ""));
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

  return entry;
}

function buildCatalog(providers, proxyPort) {
  let nativeCatalog = null;
  try {
    nativeCatalog = readNativeCatalog();
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

function injectCodexConfig(proxyPort, providers) {
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

  // Extract original model_provider / model before replacing them
  const origProvider = (existing.match(/^model_provider\s*=\s*"([^"]*)"/m) || [])[1] || "";
  const origModel = (existing.match(/^model\s*=\s*"([^"]*)"/m) || [])[1] || "";

  // Replace existing top-level model_provider / model lines in-place so
  // Codex's TOML parser never sees duplicate keys (first-wins semantics).
  existing = existing
    .replace(/^model_provider\s*=\s*.*$/m, 'model_provider = "' + providerId + '"')
    .replace(/^model\s*=\s*.*$/m, 'model = "' + modelName + '"');

  // Build managed section — only provider definition + aliases (no top-level dupes)
  const section = [
    marker,
    "# Codex-Switch proxy configuration",
    "# original_provider = \"" + origProvider + "\"",
    "# original_model = \"" + origModel + "\"",
    "",
    "[model_providers." + providerId + "]",
    'name = "' + activeProvider.name + ' (Codex-Switch)"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    'base_url = "http://127.0.0.1:' + proxyPort + '/v1"',
    "",
    "[model_providers." + providerId + ".model_aliases]",
    '"' + modelName + '" = "' + (activeProvider.model || modelName) + '"',
    endMarker,
    "",
  ].join("\n");

  fs.writeFileSync(CODEX_CONFIG_FILE, existing.trimEnd() + "\n\n" + section, "utf8");

  writeCodexAuth();

  result.ok = true;
  result.message = "Codex config updated: model=" + activeProvider.name + ", port=" + proxyPort;
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
      // Restore original model_provider / model from saved comments
      const section = content.slice(startIdx, endIdx + endMarker.length);
      const origProvider = (section.match(/^# original_provider = "([^"]*)"/m) || [])[1];
      const origModel = (section.match(/^# original_model = "([^"]*)"/m) || [])[1];

      content = content.slice(0, startIdx) + content.slice(endIdx + endMarker.length + 1);

      if (origProvider) {
        content = content.replace(/^model_provider\s*=\s*.*$/m, 'model_provider = "' + origProvider + '"');
      }
      if (origModel) {
        content = content.replace(/^model\s*=\s*.*$/m, 'model = "' + origModel + '"');
      }

      fs.writeFileSync(CODEX_CONFIG_FILE, content.trimEnd() + "\n", "utf8");
    }
  } catch {}

  // Remove auth.json if it only contains the local proxy key
  try {
    const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf8"));
    if (auth.OPENAI_API_KEY === CODEX_PROXY_AUTH_KEY) {
      fs.unlinkSync(CODEX_AUTH_FILE);
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
