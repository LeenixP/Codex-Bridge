"use strict";

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, shell } = require("electron");
const path = require("node:path");
const { loadSettings, saveSettings, loadProviders, saveProviders } = require("../shared/config");
const { createProxyServer, stopProxyServer, getStatus, getLastError } = require("../proxy/server");
const { injectCodexConfig, removeCodexConfig } = require("../codex/catalog");
const { getQuickPresets, getVariantBaseUrl } = require("../proxy/presets");
const log = require("../shared/logger");

const PRODUCT_NAME = "Codex-Switch";

let mainWindow = null;
let tray = null;
let isQuitting = false;
let settings = {};
let providers = [];

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  log.onLog((level, message, meta) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("log-entry", { level, message, time: new Date().toISOString(), meta });
    }
  });

  app.whenReady().then(bootstrap);
}

async function bootstrap() {
  settings = loadSettings();
  providers = loadProviders();

  // Apply dark title bar on Linux
  nativeTheme.themeSource = settings.theme === "dark" ? "dark" : (settings.theme === "light" ? "light" : "system");

  registerIpcHandlers();
  createMainWindow();
  createTray();

  app.on("activate", () => {
    if (!mainWindow) createMainWindow();
    else showMainWindow();
  });
}

function registerIpcHandlers() {
  ipcMain.handle("get-settings", () => settings);
  ipcMain.handle("save-settings", (_, newSettings) => {
    settings = Object.assign({}, settings, newSettings);
    saveSettings(settings);
    return settings;
  });
  ipcMain.handle("get-providers", () => providers);
  ipcMain.handle("save-providers", (_, newProviders) => {
    providers = newProviders;
    saveProviders(providers);
    return providers;
  });
  ipcMain.handle("get-proxy-status", () => getStatus());
  ipcMain.handle("get-proxy-error", () => getLastError());
  ipcMain.handle("start-proxy", async () => {
    await startProxy();
    return getStatus();
  });
  ipcMain.handle("stop-proxy", async () => {
    await stopProxyServer();
    removeCodexConfig();
    notifyProxyStatus();
    return getStatus();
  });
  ipcMain.handle("test-provider", async (_, provider) => {
    return testProviderConnection(provider);
  });
  ipcMain.handle("inject-codex-config", () => {
    return injectCodexConfig(settings.port || 8629, providers);
  });
  ipcMain.handle("remove-codex-config", () => {
    removeCodexConfig();
    return { ok: true, message: "Codex-Switch config section removed." };
  });
  ipcMain.handle("open-external", (_, url) => {
    if (typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"))) {
      shell.openExternal(url);
    }
  });
  ipcMain.handle("set-theme-source", (_, theme) => {
    nativeTheme.themeSource = theme;
  });
  ipcMain.handle("get-presets", () => getQuickPresets());
  ipcMain.handle("get-variant-baseurl", (_, provider, protocol) => {
    return getVariantBaseUrl(provider, protocol);
  });
  ipcMain.handle("get-app-version", () => {
    return app.getVersion();
  });
  ipcMain.handle("check-for-updates", async () => {
    try {
      const { request } = require("undici");
      const res = await request("https://api.github.com/repos/LeenixP/Codex-Switch/releases/latest", {
        method: "GET",
        headers: { "Accept": "application/vnd.github+json", "User-Agent": "Codex-Switch" },
        headersTimeout: 10000,
      });
      if (res.statusCode === 404) {
        const current = app.getVersion();
        return { ok: true, current: "v" + current, latest: null, newer: false, url: null };
      }
      if (res.statusCode !== 200) {
        return { ok: false, message: "GitHub API returned " + res.statusCode };
      }
      const body = await res.body.json();
      const latest = (body.tag_name || "").replace(/^v/, "");
      const current = app.getVersion();
      const newer = compareVersions(latest, current) > 0;
      return { ok: true, current: "v" + current, latest: body.tag_name, newer, url: body.html_url };
    } catch (err) {
      return { ok: false, message: err.message || "Network error" };
    }
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function startProxy() {
  try {
    await stopProxyServer();
  } catch (err) {
    console.error("[startProxy] Error stopping previous server:", err.message);
  }
  await createProxyServer(settings, providers);
  if (providers && providers.length > 0 && providers.some((p) => p.name && p.model)) {
    injectCodexConfig(settings.port || 8629, providers);
  }
  notifyProxyStatus();
  updateTrayMenu();
}

function notifyProxyStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("proxy-status-changed", getStatus());
  }
}

async function testProviderConnection(provider) {
  const { request } = require("undici");
  const baseUrl = (provider.baseUrl || "").replace(/\/+$/, "");
  const protocol = provider.protocol || "openai-chat";

  try {
    if (protocol === "anthropic") {
      // Anthropic has no GET /models — validate by posting a minimal message
      const res = await request(baseUrl + "/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": provider.apiKey || "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        headersTimeout: 10000,
        bodyTimeout: 10000,
      });
      // Any 2xx or non-auth error means the endpoint is reachable
      if (res.statusCode === 401 || res.statusCode === 403) {
        return { ok: false, status: res.statusCode, message: "Invalid API key" };
      }
      await res.body.text(); // drain
      return { ok: true, status: res.statusCode };
    }

    // OpenAI-compatible: GET /models
    const res = await request(baseUrl + "/models", {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + (provider.apiKey || ""),
      },
      headersTimeout: 10000,
    });
    const status = res.statusCode;
    await res.body.text(); // drain
    if (status === 401 || status === 403) {
      return { ok: false, status, message: "Invalid API key" };
    }
    if (status >= 200 && status < 300) return { ok: true, status };
    return { ok: false, status, message: "HTTP " + status };
  } catch (err) {
    return { ok: false, status: 0, message: err.message || "Connection failed" };
  }
}

function createMainWindow() {
  const iconPath = resolveIcon();
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    show: true,
    title: PRODUCT_NAME,
    icon: iconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    frame: true,
    backgroundColor: settings.theme === "light" ? "#ffffff" : "#09090b",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "ui", "index.html"));

  mainWindow.on("close", (event) => {
    if (!isQuitting && settings.closeBehavior === "tray") {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(resolveTrayIcon());
  tray = new Tray(icon);
  tray.setToolTip(PRODUCT_NAME);
  updateTrayMenu();

  tray.on("double-click", () => showMainWindow());
}

function trayLabel(key) {
  const isZh = settings.language === "zh";
  const map = {
    showWindow: isZh ? "显示窗口" : "Show Window",
    startProxy: isZh ? "启动代理" : "Start Proxy",
    stopProxy: isZh ? "停止代理" : "Stop Proxy",
    port: isZh ? "端口" : "Port",
    providers: isZh ? "供应商" : "Providers",
    quit: isZh ? "退出" : "Quit",
    active: isZh ? " (当前)" : " (active)",
  };
  return map[key] || key;
}

function updateTrayMenu() {
  const proxyRunning = getStatus() === "running";
  const providerItems = providers.map((p, i) => ({
    label: p.name + (p.active ? trayLabel("active") : ""),
    type: "radio",
    checked: Boolean(p.active),
    click: () => {
      providers.forEach((pr, idx) => { pr.active = idx === i; });
      saveProviders(providers);
      if (proxyRunning) {
        stopProxyServer().then(() => { removeCodexConfig(); notifyProxyStatus(); updateTrayMenu(); });
        return;
      }
      updateTrayMenu();
    },
  }));

  const template = [
    { label: trayLabel("showWindow"), click: () => showMainWindow() },
    { type: "separator" },
    { label: proxyRunning ? trayLabel("stopProxy") : trayLabel("startProxy"), click: async () => {
      if (proxyRunning) {
        await stopProxyServer();
        removeCodexConfig();
        notifyProxyStatus();
      } else {
        await startProxy();
      }
      updateTrayMenu();
    }},
    { label: trayLabel("port") + ": " + (settings.port || 8629), enabled: false },
    { type: "separator" },
    ...(providerItems.length > 0 ? [{ label: trayLabel("providers"), submenu: providerItems }] : []),
    { type: "separator" },
    { label: trayLabel("quit"), click: () => quitApp() },
  ];
  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function resolveIcon() {
  const iconsDir = path.join(__dirname, "..", "ui", "assets", "icons");
  if (process.platform === "win32") return path.join(iconsDir, "app.ico");
  if (process.platform === "darwin") return path.join(iconsDir, "app-512.png");
  return path.join(iconsDir, "app.png");
}

function resolveTrayIcon() {
  const iconsDir = path.join(__dirname, "..", "ui", "assets", "icons");
  return path.join(iconsDir, "tray.png");
}

module.exports = { PRODUCT_NAME };
