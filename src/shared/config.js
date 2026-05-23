"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const APP_NAME = "Codex-Switch";
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
  return path.join(os.homedir(), ".codex-switch");
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
    try { fs.unlinkSync(tmpPath); } catch {}
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

function loadProviders() {
  const dataDir = getDataDir();
  const providersPath = path.join(dataDir, "providers.json");
  const raw = readJsonFile(providersPath, []);
  return raw.map((p) => {
    if (p.apiKey) p.apiKey = decryptKey(p.apiKey);
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

function getActiveProvider(providers) {
  if (!Array.isArray(providers) || providers.length === 0) return null;
  return providers.find((p) => p.active) || providers[0];
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
  getActiveProvider,
  encryptKey,
  decryptKey,
};
