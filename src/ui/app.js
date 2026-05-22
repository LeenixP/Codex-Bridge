"use strict";

(function () {
  const api = window.codexSwitch;
  let providers = [];
  let settings = {};
  let editingIndex = -1;
  let lang = "zh";

  const T = {
    zh: {
      proxyRunning: "代理运行中",
      proxyStopped: "代理已停止",
      proxyStarting: "启动中...",
      proxyError: "错误",
      navProviders: "供应商",
      navSettings: "设置",
      navLogs: "日志",
      navAbout: "关于",
      providersTitle: "供应商管理",
      providersSubtitle: "管理 API 供应商，切换上游协议。",
      addProvider: "添加供应商",
      noProviders: "尚未配置供应商。",
      noProvidersHint: "点击「添加供应商」开始使用。",
      settingsTitle: "设置",
      settingsSubtitle: "配置代理行为和外观。",
      proxySection: "代理",
      listenPort: "监听端口",
      listenPortHint: "修改后需重启代理。",
      autoStart: "启动时自动运行代理",
      autoStartHint: "应用程序启动时自动开启代理。",
      thinkingVisibility: "思考可见性",
      thinkingVisible: "可见",
      thinkingHidden: "隐藏",
      appearanceSection: "外观",
      theme: "主题",
      themeDark: "暗色",
      themeLight: "浅色",
      themeSystem: "跟随系统",
      language: "语言",
      closeBehavior: "关闭行为",
      closeTray: "最小化到托盘",
      closeExit: "直接退出",
      codexIntegration: "Codex 集成",
      codexHint: "将代理配置注入 ~/.codex/config.toml，使 Codex 通过 Codex-Switch 路由请求。",
      injectConfig: "注入配置",
      removeConfig: "移除配置",
      logsTitle: "事件追踪",
      logsSubtitle: "实时代理请求和响应事件。",
      clearLogs: "清空",
      noLogs: "暂无日志。",
      aboutTitle: "关于",
      aboutEyebrow: "协议桥接",
      aboutDesc: "Codex 桌面应用的本地协议桥接，将 OpenAI Chat 和 Anthropic API 转换为 Responses 格式。",
      source: "源码",
      feedback: "反馈",
      sidebarFooter: "Codex 桌面应用的开源协议桥接工具。",
      active: "当前使用",
      edit: "编辑",
      testConn: "测试",
      delete: "删除",
      activate: "设为当前",
      dialogAddTitle: "添加供应商",
      dialogEditTitle: "编辑供应商",
      labelName: "名称",
      labelProtocol: "协议",
      labelBaseUrl: "Base URL",
      labelApiKey: "API Key",
      labelModel: "模型名",
      save: "保存",
      cancel: "取消",
      saveAndTest: "保存并测试",
      toastConnOk: "连接成功！",
      toastConnFail: "连接失败：",
      toastSaved: "已保存。",
      toastNameRequired: "请输入名称。",
      toastUrlRequired: "请输入 Base URL。",
      toastKeyRequired: "请输入 API Key。",
      toastModelRequired: "请输入模型名。",
      confirmDelete: "确定要删除供应商「{name}」吗？",
    },
    en: {
      proxyRunning: "Proxy Running",
      proxyStopped: "Proxy Stopped",
      proxyStarting: "Starting...",
      proxyError: "Error",
      navProviders: "Providers",
      navSettings: "Settings",
      navLogs: "Logs",
      navAbout: "About",
      providersTitle: "Providers",
      providersSubtitle: "Manage API providers for protocol bridging.",
      addProvider: "Add Provider",
      noProviders: "No providers configured yet.",
      noProvidersHint: 'Click "Add Provider" to get started.',
      settingsTitle: "Settings",
      settingsSubtitle: "Configure proxy behavior and appearance.",
      proxySection: "Proxy",
      listenPort: "Listen port",
      listenPortHint: "Restart required after changing.",
      autoStart: "Auto-start proxy",
      autoStartHint: "Start proxy when application launches.",
      thinkingVisibility: "Thinking visibility",
      thinkingVisible: "Visible",
      thinkingHidden: "Hidden",
      appearanceSection: "Appearance",
      theme: "Theme",
      themeDark: "Dark",
      themeLight: "Light",
      themeSystem: "System",
      language: "Language",
      closeBehavior: "Close behavior",
      closeTray: "Minimize to tray",
      closeExit: "Exit",
      codexIntegration: "Codex Integration",
      codexHint: "Inject proxy configuration into ~/.codex/config.toml so Codex routes requests through Codex-Switch.",
      injectConfig: "Inject Config",
      removeConfig: "Remove Config",
      logsTitle: "Event Trace",
      logsSubtitle: "Real-time proxy request and response events.",
      clearLogs: "Clear",
      noLogs: "No log entries yet.",
      aboutTitle: "About",
      aboutEyebrow: "Protocol Bridge",
      aboutDesc: "Local protocol bridge for Codex desktop -- converts OpenAI Chat and Anthropic APIs to Responses format.",
      source: "Source",
      feedback: "Feedback",
      sidebarFooter: "Open-source protocol bridge for Codex desktop.",
      active: "Active",
      edit: "Edit",
      testConn: "Test",
      delete: "Delete",
      activate: "Set as active",
      dialogAddTitle: "Add Provider",
      dialogEditTitle: "Edit Provider",
      labelName: "Name",
      labelProtocol: "Protocol",
      labelBaseUrl: "Base URL",
      labelApiKey: "API Key",
      labelModel: "Model",
      save: "Save",
      cancel: "Cancel",
      saveAndTest: "Save & Test",
      toastConnOk: "Connection successful!",
      toastConnFail: "Failed: ",
      toastSaved: "Saved.",
      toastNameRequired: "Name is required.",
      toastUrlRequired: "Base URL is required.",
      toastKeyRequired: "API Key is required.",
      toastModelRequired: "Model is required.",
      confirmDelete: 'Delete provider "{name}"?',
    },
  };

  function t(key, params) {
    let text = (T[lang] && T[lang][key]) || (T.en[key]) || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace("{" + k + "}", v);
      }
    }
    return text;
  }

  const PRESETS = [
    { name: "OpenAI", protocol: "openai-chat", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
    { name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-20250514" },
    { name: "DeepSeek", protocol: "openai-chat", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    { name: "Groq", protocol: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
    { name: "Together", protocol: "openai-chat", baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  ];

  function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      const attr = el.dataset.i18nAttr;
      if (attr) {
        el.setAttribute(attr, t(key));
      } else if (el.tagName === "INPUT" && el.type === "text") {
        el.placeholder = t(key);
      } else {
        el.textContent = t(key);
      }
    });

    // Subtitle with <small> child
    document.querySelectorAll("[data-i18n-sub]").forEach((el) => {
      const key = el.dataset.i18nSub;
      const small = el.querySelector("small");
      if (small) small.textContent = t(key);
    });

    // Update proxy status label
    updateProxyStatusLabel();

    // Update dynamic content: providers list, about desc
    if (providers !== undefined) renderProviders();
    document.getElementById("app-version").textContent = "v0.1.0";
  }

  function updateProxyStatusLabel() {
    const el = document.getElementById("proxy-status");
    if (!el) return;
    const text = el.querySelector(".status-text");
    const labels = {
      running: t("proxyRunning"),
      stopped: t("proxyStopped"),
      starting: t("proxyStarting"),
      error: t("proxyError"),
    };
    const status = el.classList.contains("running") ? "running"
      : el.classList.contains("starting") ? "starting"
      : el.classList.contains("stopped") ? "stopped"
      : el.classList.contains("error") ? "error"
      : "stopped";
    text.textContent = labels[status] || status;
  }

  // Navigation
  const navItems = document.querySelectorAll(".nav-item");
  const pages = document.querySelectorAll(".page");
  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      const target = item.dataset.page;
      navItems.forEach((n) => n.classList.remove("active"));
      pages.forEach((p) => p.classList.remove("active"));
      item.classList.add("active");
      document.getElementById("page-" + target).classList.add("active");
    });
  });

  // Initialize
  async function init() {
    if (api) {
      settings = await api.getSettings();
      providers = await api.getProviders();
      lang = settings.language || "zh";
      const status = await api.getProxyStatus();
      updateProxyStatus(status);
      api.onProxyStatusChange(updateProxyStatus);
    }
    applySettings();
    applyTranslations();
  }

  // Proxy status
  async function updateProxyStatus(status) {
    const el = document.getElementById("proxy-status");
    if (!el) return;
    el.className = "proxy-status " + status;
    // Show error detail on hover
    if (status === "error" && api) {
      try {
        const errMsg = await api.getProxyError();
        el.title = errMsg || "Unknown proxy error";
      } catch {}
    } else {
      el.title = "";
    }
    updateProxyStatusLabel();
  }

  // Settings
  function applySettings() {
    document.getElementById("setting-port").value = settings.port || 8629;
    document.getElementById("setting-autostart").checked = settings.autoStart !== false;

    setRadio("thinking", settings.thinkingVisibility || "visible");
    setRadio("theme", settings.theme || "dark");
    setRadio("language", settings.language || "zh");
    setRadio("close", settings.closeBehavior || "tray");

    applyTheme(settings.theme || "dark");
  }

  function setRadio(name, value) {
    const radios = document.querySelectorAll('input[name="' + name + '"]');
    radios.forEach((r) => { r.checked = r.value === value; });
  }

  function getRadio(name) {
    const checked = document.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : "";
  }

  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  }

  // Settings change listeners
  document.getElementById("setting-port").addEventListener("change", saveCurrentSettings);
  document.getElementById("setting-autostart").addEventListener("change", saveCurrentSettings);
  document.querySelectorAll('input[name="thinking"]').forEach((r) => r.addEventListener("change", saveCurrentSettings));
  document.querySelectorAll('input[name="close"]').forEach((r) => r.addEventListener("change", saveCurrentSettings));
  document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener("change", () => {
    applyTheme(getRadio("theme"));
    saveCurrentSettings();
  }));
  document.querySelectorAll('input[name="language"]').forEach((r) => r.addEventListener("change", async () => {
    lang = getRadio("language");
    settings.language = lang;
    if (api) await api.saveSettings(settings);
    applyTranslations();
  }));

  async function saveCurrentSettings() {
    settings.port = Number(document.getElementById("setting-port").value) || 8629;
    settings.autoStart = document.getElementById("setting-autostart").checked;
    settings.thinkingVisibility = getRadio("thinking");
    settings.theme = getRadio("theme");
    settings.language = getRadio("language");
    settings.closeBehavior = getRadio("close");
    if (api) await api.saveSettings(settings);
  }

  // Codex integration
  document.getElementById("btn-inject-codex").addEventListener("click", async () => {
    if (!api) return;
    const result = await api.injectCodexConfig();
    showToast(result.message, result.ok ? "success" : "error");
  });
  document.getElementById("btn-remove-codex").addEventListener("click", async () => {
    if (!api) return;
    const result = await api.removeCodexConfig();
    showToast(result.message, result.ok ? "success" : "error");
  });

  // Provider rendering
  function renderProviders() {
    const list = document.getElementById("provider-list");
    if (!providers || providers.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>' + t("noProviders") + '</p><p>' + t("noProvidersHint") + '</p></div>';
      return;
    }
    list.innerHTML = providers.map((p, i) => providerCardHtml(p, i)).join("");
    bindProviderActions();
  }

  function providerCardHtml(provider, index) {
    const activeClass = provider.active ? " active" : "";
    const protocolLabel = provider.protocol === "anthropic" ? "Anthropic" : "OpenAI Chat";
    const statusLabel = provider.active ? '<span class="status-badge active">' + t("active") + '</span>' : "";
    return '<div class="provider-card' + activeClass + '" data-index="' + index + '">' +
      '<div class="provider-icon">' + protocolIcon(provider.protocol) + '</div>' +
      '<div class="provider-info">' +
      '<div class="provider-name">' + escapeHtml(provider.name) + ' ' + statusLabel + '</div>' +
      '<div class="provider-detail"><span class="protocol-badge">' + protocolLabel + '</span> ' + escapeHtml(provider.model || "") + '</div>' +
      '<div class="provider-url">' + escapeHtml(provider.baseUrl || "") + '</div>' +
      '</div>' +
      '<div class="provider-actions">' +
      (provider.active ? "" : '<button class="btn-icon btn-activate" title="' + t("activate") + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></button>') +
      '<button class="btn-icon btn-test" title="' + t("testConn") + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></button>' +
      '<button class="btn-icon btn-edit" title="' + t("edit") + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
      '<button class="btn-icon btn-delete" title="' + t("delete") + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
      '</div></div>';
  }

  function protocolIcon(protocol) {
    if (protocol === "anthropic") {
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
    }
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>';
  }

  function bindProviderActions() {
    document.querySelectorAll(".btn-activate").forEach((btn) => {
      btn.addEventListener("click", (e) => { activateProvider(getCardIndex(e.target)); });
    });
    document.querySelectorAll(".btn-edit").forEach((btn) => {
      btn.addEventListener("click", (e) => { openEditDialog(getCardIndex(e.target)); });
    });
    document.querySelectorAll(".btn-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => { deleteProvider(getCardIndex(e.target)); });
    });
    document.querySelectorAll(".btn-test").forEach((btn) => {
      btn.addEventListener("click", (e) => { testProvider(getCardIndex(e.target)); });
    });
  }

  function getCardIndex(el) {
    return Number(el.closest(".provider-card").dataset.index);
  }

  async function activateProvider(index) {
    providers.forEach((p, i) => { p.active = i === index; });
    if (api) await api.saveProviders(providers);
    renderProviders();
  }

  async function deleteProvider(index) {
    const name = providers[index].name;
    if (!confirm(t("confirmDelete", { name }))) return;
    providers.splice(index, 1);
    if (providers.length > 0 && !providers.some((p) => p.active)) providers[0].active = true;
    if (api) await api.saveProviders(providers);
    renderProviders();
  }

  async function testProvider(index) {
    const provider = providers[index];
    try {
      const result = api ? await api.testProvider(provider) : { ok: false, message: "No IPC" };
      showToast(result.ok ? t("toastConnOk") : t("toastConnFail") + (result.message || "Unknown"), result.ok ? "success" : "error");
    } catch (err) {
      showToast("Error: " + err.message, "error");
    }
  }

  // Add/Edit Provider Dialog
  document.getElementById("btn-add-provider").addEventListener("click", () => {
    editingIndex = -1;
    showDialog({ title: t("dialogAddTitle"), name: "", protocol: "openai-chat", baseUrl: "", apiKey: "", model: "" });
  });

  function openEditDialog(index) {
    editingIndex = index;
    const p = providers[index];
    showDialog({ title: t("dialogEditTitle"), name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model });
  }

  function showDialog(data) {
    let dialog = document.getElementById("provider-dialog");
    if (!dialog) {
      dialog = document.createElement("div");
      dialog.id = "provider-dialog";
      dialog.className = "dialog-overlay";
      document.body.appendChild(dialog);
    }

    dialog.innerHTML = '<div class="dialog">' +
      '<div class="dialog-header"><h2>' + data.title + '</h2><button class="btn-close" id="dialog-close">&times;</button></div>' +
      '<div class="dialog-body">' +
      '<div class="preset-buttons">' + PRESETS.map((p, i) => '<button class="btn-preset" data-preset="' + i + '">' + escapeHtml(p.name) + '</button>').join("") + '</div>' +
      '<div class="form-group"><label>' + t("labelName") + '</label><input type="text" id="dlg-name" value="' + escapeAttr(data.name) + '" placeholder="My Provider"></div>' +
      '<div class="form-group"><label>' + t("labelProtocol") + '</label><select id="dlg-protocol"><option value="openai-chat"' + (data.protocol === "openai-chat" ? " selected" : "") + '>OpenAI Chat</option><option value="anthropic"' + (data.protocol === "anthropic" ? " selected" : "") + '>Anthropic</option></select></div>' +
      '<div class="form-group"><label>' + t("labelBaseUrl") + '</label><input type="text" id="dlg-baseurl" value="' + escapeAttr(data.baseUrl) + '" placeholder="https://api.openai.com/v1"></div>' +
      '<div class="form-group"><label>' + t("labelApiKey") + '</label><input type="password" id="dlg-apikey" value="' + escapeAttr(data.apiKey) + '" placeholder="sk-..."></div>' +
      '<div class="form-group"><label>' + t("labelModel") + '</label><input type="text" id="dlg-model" value="' + escapeAttr(data.model) + '" placeholder="gpt-4o"></div>' +
      '</div>' +
      '<div class="dialog-footer">' +
      '<button class="btn btn-secondary" id="dlg-cancel">' + t("cancel") + '</button>' +
      '<button class="btn btn-primary" id="dlg-save">' + t("save") + '</button>' +
      '</div></div>';

    dialog.style.display = "flex";
    dialog.querySelector("#dialog-close").addEventListener("click", closeDialog);
    dialog.querySelector("#dlg-cancel").addEventListener("click", closeDialog);
    dialog.querySelector("#dlg-save").addEventListener("click", saveDialog);
    dialog.querySelectorAll(".btn-preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = PRESETS[Number(btn.dataset.preset)];
        document.getElementById("dlg-name").value = preset.name;
        document.getElementById("dlg-protocol").value = preset.protocol;
        document.getElementById("dlg-baseurl").value = preset.baseUrl;
        document.getElementById("dlg-model").value = preset.model;
      });
    });
    dialog.addEventListener("click", (e) => { if (e.target === dialog) closeDialog(); });
  }

  function closeDialog() {
    const dialog = document.getElementById("provider-dialog");
    if (dialog) dialog.style.display = "none";
  }

  async function saveDialog() {
    const name = document.getElementById("dlg-name").value.trim();
    const protocol = document.getElementById("dlg-protocol").value;
    const baseUrl = document.getElementById("dlg-baseurl").value.trim();
    const apiKey = document.getElementById("dlg-apikey").value.trim();
    const model = document.getElementById("dlg-model").value.trim();

    if (!name) { showToast(t("toastNameRequired"), "error"); return; }
    if (!baseUrl) { showToast(t("toastUrlRequired"), "error"); return; }
    if (!apiKey) { showToast(t("toastKeyRequired"), "error"); return; }
    if (!model) { showToast(t("toastModelRequired"), "error"); return; }

    const entry = { name, protocol, baseUrl, apiKey, model, active: false };
    if (editingIndex >= 0) {
      entry.active = providers[editingIndex].active;
      providers[editingIndex] = entry;
    } else {
      if (providers.length === 0) entry.active = true;
      providers.push(entry);
    }

    if (api) await api.saveProviders(providers);
    renderProviders();
    closeDialog();
  }

  // Toast
  function showToast(message, type) {
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = "toast toast-" + (type || "info");
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add("fade-out"); }, 2500);
    setTimeout(() => { toast.remove(); }, 3000);
  }

  // Logs
  const logEntries = [];
  document.getElementById("btn-clear-logs").addEventListener("click", () => {
    logEntries.length = 0;
    renderLogs();
  });

  function renderLogs() {
    const list = document.getElementById("log-list");
    if (logEntries.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>' + t("noLogs") + '</p></div>';
      return;
    }
    list.innerHTML = logEntries.map((e) =>
      '<div class="log-entry"><span class="log-time">' + e.time + '</span><span class="log-level ' + e.level + '">' + e.level + '</span><span class="log-message">' + escapeHtml(e.message) + '</span></div>'
    ).join("");
  }

  // Utilities
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return (text || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // GitHub / Feedback links
  document.getElementById("link-github").addEventListener("click", () => {
    if (api && api.platform) {
      require("electron").shell.openExternal("https://github.com/LeenixP/Codex-Switch");
    }
  });
  document.getElementById("link-issues").addEventListener("click", () => {
    if (api && api.platform) {
      require("electron").shell.openExternal("https://github.com/LeenixP/Codex-Switch/issues");
    }
  });

  // Boot
  init();
})();