"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexSwitch", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  getProviders: () => ipcRenderer.invoke("get-providers"),
  saveProviders: (providers) => ipcRenderer.invoke("save-providers", providers),
  getProxyStatus: () => ipcRenderer.invoke("get-proxy-status"),
  startProxy: () => ipcRenderer.invoke("start-proxy"),
  stopProxy: () => ipcRenderer.invoke("stop-proxy"),
  testProvider: (provider) => ipcRenderer.invoke("test-provider", provider),
  injectCodexConfig: () => ipcRenderer.invoke("inject-codex-config"),
  removeCodexConfig: () => ipcRenderer.invoke("remove-codex-config"),
  onProxyStatusChange: (callback) => {
    ipcRenderer.on("proxy-status-changed", (_, status) => callback(status));
  },
  platform: process.platform,
});
