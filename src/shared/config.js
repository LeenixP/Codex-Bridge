"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const APP_NAME = "Codex-Switch";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

function getDataDir() {
  const platform = process.platform;
  if (platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), APP_NAME);
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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function loadSettings() {
  const dataDir = getDataDir();
  ensureDir(dataDir);
  const settingsPath = path.join(dataDir, "settings.json");
  const defaults = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    autoStart: true,
    theme: "dark",
    language: "zh",
    closeBehavior: "tray",
    thinkingVisibility: "visible",
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
  return readJsonFile(providersPath, []);
}

function saveProviders(providers) {
  const dataDir = getDataDir();
  ensureDir(dataDir);
  const providersPath = path.join(dataDir, "providers.json");
  writeJsonFile(providersPath, providers);
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
};