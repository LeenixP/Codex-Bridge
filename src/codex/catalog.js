"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEX_CONFIG_DIR = path.join(os.homedir(), ".codex");
const CODEX_CONFIG_FILE = path.join(CODEX_CONFIG_DIR, "config.toml");
const CODEX_AUTH_FILE = path.join(CODEX_CONFIG_DIR, "auth.json");
const CODEX_PROXY_AUTH_KEY = "codex-switch-local";
const CATALOG_TIMEOUT_MS = parseInt(process.env.CODEX_CATALOG_TIMEOUT_MS || "15000", 10);
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
  const invocation = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
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
  const code = lastError && lastError.code || "UNKNOWN";
  const msg = lastError && lastError.killed
    ? "Codex CLI timed out after " + CATALOG_TIMEOUT_MS + "ms (" + (retries + 1) + " attempt(s)). Try setting CODEX_CATALOG_TIMEOUT_MS env var."
    : "Failed to run codex CLI (exit code: " + code + "): " + (lastError && lastError.message || "");
  throw new Error(msg);
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

  // Extract original model_provider / model before replacing them
  const origProvider = (existing.match(/^model_provider\s*=\s*"([^"]*)"/m) || [])[1] || "";
  const origModel = (existing.match(/^model\s*=\s*"([^"]*)"/m) || [])[1] || "";

  // Replace existing top-level model_provider / model lines in-place so
  // Codex's TOML parser never sees duplicate keys (first-wins semantics).
  existing = existing
    .replace(/^model_provider\s*=\s*.*$/m, 'model_provider = "' + providerId + '"')
    .replace(/^model\s*=\s*.*$/m, 'model = "' + modelName + '"');

  // Detect and comment out preferred_auth_method = "apikey" — it conflicts
  // with the hybrid OAuth + proxy mode and causes Codex to hang on startup.
  const authMethodFixed = /^preferred_auth_method\s*=\s*"apikey"/m.test(existing);
  if (authMethodFixed) {
    existing = existing.replace(
      /^preferred_auth_method\s*=\s*"apikey"/m,
      "# preferred_auth_method = \"apikey\"  # Codex-Switch: commented out — incompatible with hybrid OAuth mode"
    );
  }

  // Collect all known Codex model slugs so we can alias them to the
  // active provider model.  This prevents Codex background tasks
  // (title generation, etc.) from sending native model names like
  // gpt-5.4-mini directly to the upstream provider.
  let nativeModelSlugs = [];
  try {
    const nativeCatalog = await readNativeCatalog();
    if (nativeCatalog && Array.isArray(nativeCatalog.models)) {
      nativeModelSlugs = nativeCatalog.models.map(function (m) { return m.slug; });
    }
  } catch {}

  // Add our own codex-switch prefixed models
  const allAliasSlugs = [modelName].concat(nativeModelSlugs.filter(function (s) { return s !== modelName; }));

  const aliasLines = allAliasSlugs.map(function (slug) {
    return '"' + slug + '" = "' + (activeProvider.model || modelName) + '"';
  });

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
    'api_key = "' + CODEX_PROXY_AUTH_KEY + '"',
    'base_url = "http://127.0.0.1:' + proxyPort + '/v1"',
    "",
    "[model_providers." + providerId + ".model_aliases]",
  ].concat(aliasLines).concat([
    endMarker,
    "",
  ]).join("\n");

  fs.writeFileSync(CODEX_CONFIG_FILE, existing.trimEnd() + "\n\n" + section, "utf8");

  // Clean up dummy key left by older Codex-Switch versions.
  // Only removes the OPENAI_API_KEY field — preserves OAuth tokens.
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

  // Note: auth.json is intentionally left untouched beyond the cleanup above.
  // With requires_openai_auth = true, Codex uses the ChatGPT OAuth session
  // for auth-layer features (plugins, Mobile, quotas), while model requests
  // route through the local proxy.  The api_key in the provider config is
  // the Bearer token Codex sends; the proxy ignores it and uses its own keys.

  result.ok = true;
  result.message = "Codex config updated: model=" + activeProvider.name + ", port=" + proxyPort;
  if (authMethodFixed) {
    result.message += " | Fixed: commented out preferred_auth_method=apikey (incompatible with hybrid OAuth mode)";
  }
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

  // Clean up dummy key that may have been written by an older version.
  // Only remove the OPENAI_API_KEY field — never delete the file,
  // as it may contain valid ChatGPT OAuth tokens.
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
