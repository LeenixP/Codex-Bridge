"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const path = require("node:path");
const os = require("node:os");

const DATA_DIR = path.join(os.homedir(), ".codex-switch");

contextBridge.exposeInMainWorld("codexSwitch", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  getProviders: () => ipcRenderer.invoke("get-providers"),
  saveProviders: (providers) => ipcRenderer.invoke("save-providers", providers),
  getProxyStatus: () => ipcRenderer.invoke("get-proxy-status"),
  getProxyError: () => ipcRenderer.invoke("get-proxy-error"),
  startProxy: () => ipcRenderer.invoke("start-proxy"),
  stopProxy: () => ipcRenderer.invoke("stop-proxy"),
  testProvider: (provider) => ipcRenderer.invoke("test-provider", provider),
  injectCodexConfig: () => ipcRenderer.invoke("inject-codex-config"),
  removeCodexConfig: () => ipcRenderer.invoke("remove-codex-config"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  setThemeSource: (theme) => ipcRenderer.invoke("set-theme-source", theme),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  getPresets: () => ipcRenderer.invoke("get-presets"),
  getVariantBaseUrl: (provider, protocol) => ipcRenderer.invoke("get-variant-baseurl", provider, protocol),
  onProxyStatusChange: (callback) => {
    ipcRenderer.on("proxy-status-changed", (_, status) => callback(status));
  },
  onLogEntry: (callback) => {
    ipcRenderer.on("log-entry", (_, entry) => callback(entry));
  },
  setLogLevel: (level) => ipcRenderer.invoke("set-log-level", level),
  platform: process.platform,
  dataDir: DATA_DIR,
  traceDir: path.join(DATA_DIR, "trace"),
});
