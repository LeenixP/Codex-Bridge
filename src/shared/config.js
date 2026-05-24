"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const APP_NAME = "Codex-Bridge";
const DEFAULT_PORT = 8629;
const DEFAULT_HOST = "127.0.0.1";

// Lazy-load safeStorage — only available in Electron main process
function getSafeStorage() {
  try {
    const { safeStorage } = require("electron");
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage;
    }
  } catch {}
  return null;
}

const ENCRYPTED_PREFIX = "cs_enc_v1:";

function encryptKey(plaintext) {
  if (!plaintext) return plaintext;
  const ss = getSafeStorage();
  if (!ss) return plaintext;
  try {
    const buf = ss.encryptString(plaintext);
    return ENCRYPTED_PREFIX + buf.toString("base64");
  } catch {
    return plaintext;
  }
}

function decryptKey(stored) {
  if (!stored || typeof stored !== "string") return "";
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored;
  const ss = getSafeStorage();
  if (!ss) return "";
  try {
    const buf = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), "base64");
    return ss.decryptString(buf);
  } catch {
    return "";
  }
}

function getDataDir() {
  return path.join(os.homedir(), ".codex-bridge");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile(filePath, fallback) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = filePath + ".tmp." + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    // if rename fails, try direct write as fallback
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
}

function loadSettings() {
  const dataDir = getDataDir();
  ensureDir(dataDir);
  const settingsPath = path.join(dataDir, "settings.json");
  const defaults = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    theme: "dark",
    language: "zh",
    closeBehavior: "tray",
    logLevel: "info",
    traceEnabled: false,
  };
  const saved = readJsonFile(settingsPath, {});
  return Object.assign({}, defaults, saved);
}

function saveSettings(settings) {
  const dataDir = getDataDir();
  ensureDir(dataDir);
  const settingsPath = path.join(dataDir, "settings.json");
  writeJsonFile(settingsPath, settings);
}

function migrateProvider(p) {
  if (p.models && Array.isArray(p.models)) return p;
  var modelId = p.model || "";
  if (modelId) {
    p.models = [{ id: modelId, maxOutputK: 64, maxContextK: 128 }];
  } else {
    p.models = [];
  }
  delete p.model;
  return p;
}

function loadProviders() {
  const dataDir = getDataDir();
  const providersPath = path.join(dataDir, "providers.json");
  const raw = readJsonFile(providersPath, []);
  var existingKeys = new Set();
  return raw.map((p) => {
    if (p.apiKey) p.apiKey = decryptKey(p.apiKey);
    migrateProvider(p);
    if (!p.key) {
      p.key = generateKey(p.name, existingKeys);
    }
    existingKeys.add(p.key);
    return p;
  });
}

function saveProviders(providers) {
  const dataDir = getDataDir();
  ensureDir(dataDir);
  const providersPath = path.join(dataDir, "providers.json");
  const toStore = providers.map((p) => {
    const entry = Object.assign({}, p);
    if (entry.apiKey) entry.apiKey = encryptKey(entry.apiKey);
    return entry;
  });
  writeJsonFile(providersPath, toStore);
}

var ZH_EN_MAP = {
  "\u667a\u8c31": "zhipu",
  "\u6df1\u5ea6\u6c42\u7d22": "deepseek",
  "\u963f\u91cc": "aliyun",
  "\u767e\u5ea6": "baidu",
  "\u6708\u4e4b\u6697\u9762": "moonshot",
  "\u8df3\u8dc3\u661f\u8fb0": "stepfun",
  "\u8baf\u98de": "xunfei",
  "\u5b57\u8282": "bytedance",
  "\u8c37\u6b4c": "google",
  "\u5fae\u8f6f": "microsoft",
  "\u4e9a\u9a6c\u900a": "amazon",
  "\u7f51\u6613": "netease",
  "\u5546\u6c64": "sensetime",
  "\u5343\u95ee": "qianwen",
};

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function generateKey(name, existingKeys) {
  var key;
  if (ZH_EN_MAP[name]) {
    key = ZH_EN_MAP[name];
  } else {
    var slug = slugify(name);
    key = slug || "provider";
  }
  if (!existingKeys || !existingKeys.has(key)) return key;
  var n = 2;
  while (existingKeys.has(key + "-" + n)) n++;
  return key + "-" + n;
}

function getExistingKeys(providers) {
  var s = new Set();
  (providers || []).forEach(function (p) {
    if (p.key) s.add(p.key);
  });
  return s;
}

function getProviderByModel(providers, model) {
  if (!Array.isArray(providers) || providers.length === 0) return null;
  if (model) {
    var slashIdx = model.indexOf("/");
    if (slashIdx !== -1) {
      var reqKey = model.substring(0, slashIdx);
      var reqModelId = model.substring(slashIdx + 1);
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        if (p.key === reqKey) {
          var models = p.models || [];
          for (var j = 0; j < models.length; j++) {
            if (models[j].id === reqModelId) {
              return { provider: p, modelConfig: models[j] };
            }
          }
        }
      }
      return null;
    }
    for (var fi = 0; fi < providers.length; fi++) {
      var fp = providers[fi];
      var fmodels = fp.models || [];
      for (var fj = 0; fj < fmodels.length; fj++) {
        if (fmodels[fj].id === model) {
          return { provider: fp, modelConfig: fmodels[fj] };
        }
      }
    }
  }
  return null;
}

module.exports = {
  APP_NAME,
  DEFAULT_PORT,
  DEFAULT_HOST,
  getDataDir,
  ensureDir,
  readJsonFile,
  writeJsonFile,
  loadSettings,
  saveSettings,
  loadProviders,
  saveProviders,
  getProviderByModel,
  generateKey,
  getExistingKeys,
  encryptKey,
  decryptKey,
  migrateProvider,
};
