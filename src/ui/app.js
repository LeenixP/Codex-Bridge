"use strict";

(function () {
  window.addEventListener("unhandledrejection", function (event) {
    diag("Unhandled rejection: " + (event.reason ? event.reason.message || String(event.reason) : "unknown"));
    console.error("Unhandled rejection:", event.reason);
  });
  const api = window.codexBridge;
  const T = window.T;
  let providers = [];
  let settings = {};
  let editingIndex = -1;
  let lang = "zh";

  function t(key, params) {
    let text = (T[lang] && T[lang][key]) || T.en[key] || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace("{" + k + "}", v);
      }
    }
    return text;
  }

  let PRESETS = [];
  let selectedPreset = null; // preset id chosen in the dialog
  let _proxyStatus = "stopped"; // source of truth, avoids DOM class race

  (async function loadPresets() {
    if (api && api.getPresets) {
      try {
        PRESETS = await api.getPresets();
      } catch (err) {
        diag("loadPresets failed: " + err.message);
      }
    }
  })();

  function applyTranslations() {
    document.documentElement.lang = lang || "en";
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

    document.querySelectorAll("[data-tip-key]").forEach((el) => {
      el.setAttribute("data-tooltip", t(el.getAttribute("data-tip-key")));
    });

    // Update proxy status label
    updateProxyStatusLabel();

    // Update dynamic content: providers list, about desc
    if (providers !== undefined) renderProviders();
    renderQuickstart();
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
    text.textContent = labels[_proxyStatus] || _proxyStatus;
  }

  // Navigation
  const navItems = document.querySelectorAll(".nav-item");
  const pages = document.querySelectorAll(".page");
  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      const target = item.dataset.page;
      navItems.forEach((n) => {
        n.classList.remove("active");
        n.removeAttribute("aria-current");
      });
      pages.forEach((p) => p.classList.remove("active"));
      item.classList.add("active");
      item.setAttribute("aria-current", "page");
      document.getElementById("page-" + target).classList.add("active");
      if (target === "logs") renderLogs();
    });
  });

  // Diagnostic logger — writes to About page
  function diag(msg) {
    const el = document.getElementById("diag-output");
    if (el) {
      el.style.display = "block";
      el.textContent += "[" + new Date().toISOString().slice(11, 19) + "] " + msg + "\n";
    }
  }

  // Initialize
  async function init() {
    // Diagnostic: check api shape
    diag("init: api=" + typeof api + (api ? " keys=" + Object.keys(api).join(",") : " NULL"));
    diag("init: api.getAppVersion=" + (api && typeof api.getAppVersion));
    diag("init: api.openExternal=" + (api && typeof api.openExternal));
    diag("init: api.checkForUpdates=" + (api && typeof api.checkForUpdates));
    diag("init: lang=" + lang + " platform=" + (api ? api.platform : "?"));

    // Run version + paths first — they must not depend on other IPC calls
    showVersion();
    showPaths();

    try {
      if (api) {
        diag("init: reading settings...");
        settings = await api.getSettings();
        diag("init: settings ok, port=" + settings.port + " theme=" + settings.theme);
        providers = await api.getProviders();
        diag("init: providers ok, count=" + (providers ? providers.length : 0));
        lang = settings.language || "zh";
        const status = await api.getProxyStatus();
        diag("init: proxy status=" + status);
        updateProxyStatus(status);
        api.onProxyStatusChange(updateProxyStatus);
        if (api.onLogEntry) {
          api.onLogEntry((entry) => {
            logEntries.push(entry);
            if (logEntries.length > 500) logEntries.shift();
            if (document.getElementById("page-logs").classList.contains("active")) {
              renderLogs();
            }
          });
        }
      }
      applySettings();
      applyTranslations();
    } catch (err) {
      diag("init: ERROR " + (err.message || err));
      console.error("Failed to initialize:", err);
    }

    // Listen for system theme changes
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (settings.theme === "system") applyTheme("system");
    });
  }

  // Proxy status
  async function updateProxyStatus(status) {
    _proxyStatus = status;
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
    updateProxyButton();
  }

  function showVersion() {
    diag("showVersion: called");
    if (!api) {
      diag("showVersion: api is NULL");
      return;
    }
    if (!api.getAppVersion) {
      diag("showVersion: api.getAppVersion is " + typeof api.getAppVersion);
      return;
    }
    api
      .getAppVersion()
      .then(function (v) {
        diag("showVersion: got version=" + JSON.stringify(v));
        const el = document.getElementById("app-version");
        if (el) {
          el.textContent = "v" + v;
          diag("showVersion: DOM updated");
        } else diag("showVersion: #app-version not found");
      })
      .catch(function (e) {
        diag("showVersion: ERROR " + (e.message || e));
      });
  }

  function showPaths() {
    if (!api) return;
    const dataDir = api.dataDir || "~/.codex-bridge";
    const traceDir = api.traceDir || dataDir + "/trace";
    const dataPathEl = document.getElementById("data-dir-path");
    const tracePathEl = document.getElementById("trace-dir-path");
    if (dataPathEl) dataPathEl.textContent = dataDir;
    if (tracePathEl) tracePathEl.textContent = traceDir;
  }

  // Settings
  function applySettings() {
    document.getElementById("setting-port").value = settings.port || 8629;
    var lanCheckbox = document.getElementById("setting-lan");
    if (lanCheckbox) lanCheckbox.checked = settings.host === "0.0.0.0";

    setRadio("theme", settings.theme || "dark");
    setRadio("language", settings.language || "zh");
    setRadio("loglevel", settings.logLevel || "info");
    setRadio("close", settings.closeBehavior || "tray");

    // Trace mode toggle
    const traceCheckbox = document.getElementById("setting-trace");
    if (traceCheckbox) traceCheckbox.checked = Boolean(settings.traceEnabled);

    applyTheme(settings.theme || "dark");
  }

  function setRadio(name, value) {
    const radios = document.querySelectorAll('input[name="' + name + '"]');
    radios.forEach((r) => {
      r.checked = r.value === value;
    });
  }

  function getRadio(name) {
    const checked = document.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : "";
  }

  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else if (theme === "system") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
    } else {
      document.documentElement.setAttribute("data-theme", "dark");
    }
    if (api && api.setThemeSource) api.setThemeSource(theme);
  }

  // Settings change listeners
  document.getElementById("setting-port").addEventListener("change", saveCurrentSettings);
  var lanCheckbox = document.getElementById("setting-lan");
  if (lanCheckbox) lanCheckbox.addEventListener("change", saveCurrentSettings);
  document.querySelectorAll('input[name="close"]').forEach((r) => r.addEventListener("change", saveCurrentSettings));
  document.querySelectorAll('input[name="theme"]').forEach((r) =>
    r.addEventListener("change", () => {
      applyTheme(getRadio("theme"));
      saveCurrentSettings();
    }),
  );
  document.querySelectorAll('input[name="language"]').forEach((r) =>
    r.addEventListener("change", async () => {
      lang = getRadio("language");
      settings.language = lang;
      if (api) await api.saveSettings(settings);
      applyTranslations();
    }),
  );
  document.querySelectorAll('input[name="loglevel"]').forEach((r) =>
    r.addEventListener("change", async () => {
      settings.logLevel = getRadio("loglevel");
      if (api) {
        await api.saveSettings(settings);
        await api.setLogLevel(settings.logLevel);
      }
    }),
  );

  const traceCheckbox = document.getElementById("setting-trace");
  if (traceCheckbox) {
    traceCheckbox.addEventListener("change", async () => {
      settings.traceEnabled = traceCheckbox.checked;
      if (api) await api.saveSettings(settings);
    });
  }

  async function saveCurrentSettings() {
    try {
      settings.port = Number(document.getElementById("setting-port").value) || 8629;
      var lanEl = document.getElementById("setting-lan");
      settings.host = lanEl && lanEl.checked ? "0.0.0.0" : "127.0.0.1";
      settings.theme = getRadio("theme");
      settings.language = getRadio("language");
      settings.logLevel = getRadio("loglevel");
      settings.closeBehavior = getRadio("close");
      if (api) await api.saveSettings(settings);
    } catch (err) {
      console.error("Failed to save settings:", err);
      showToast("Save failed: " + err.message, "error");
    }
  }

  // Sidebar proxy toggle button
  let needsRestart = false;

  function markNeedsRestart() {
    needsRestart = true;
    updateProxyButton();
  }

  function clearNeedsRestart() {
    needsRestart = false;
    updateProxyButton();
  }

  function updateProxyButton() {
    const btn = document.getElementById("btn-toggle-proxy");
    if (!btn) return;
    const label = btn.querySelector(".btn-label");
    const isRunning = _proxyStatus === "running";
    const isLoading = _proxyStatus === "starting";

    btn.className = "sidebar-proxy-btn";
    if (isLoading) {
      btn.classList.add("loading");
      if (label) label.textContent = "...";
    } else if (isRunning) {
      btn.classList.add("running");
      if (label) label.textContent = t("stopProxy");
    } else if (needsRestart) {
      btn.classList.add("stopped", "flash");
      if (label) label.textContent = t("startProxy");
    } else {
      btn.classList.add("stopped");
      if (label) label.textContent = t("startProxy");
    }
  }

  document.getElementById("btn-toggle-proxy").addEventListener("click", async () => {
    if (!api) return;
    const btn = document.getElementById("btn-toggle-proxy");
    if (!btn) return;

    const isRunning = _proxyStatus === "running";
    if (btn.classList.contains("loading")) return;

    // Loading state
    btn.classList.add("loading");
    btn.classList.remove("flash");
    const label = btn.querySelector(".btn-label");
    if (label) label.textContent = "...";

    try {
      if (isRunning) {
        // Stop proxy + remove config
        await api.stopProxy();
        clearNeedsRestart();
      } else {
        // Start proxy
        await api.startProxy();
        clearNeedsRestart();
      }
    } catch (err) {
      showToast("Error: " + err.message, "error");
    }
  });

  // Provider rendering
  function renderProviders() {
    const list = document.getElementById("provider-list");
    if (!providers || providers.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>' + t("noProviders") + "</p><p>" + t("noProvidersHint") + "</p></div>";
      return;
    }
    list.innerHTML = providers.map((p, i) => providerCardHtml(p, i)).join("");
    bindProviderActions();
  }

  function providerCardHtml(provider, index) {
    const protocolLabel = provider.protocol === "anthropic" ? t("protocolAnthropic") : t("protocolOpenAI");
    const isVendorPreset = provider.preset && provider.preset !== "openai-chat" && provider.preset !== "anthropic";
    const presetLabel = isVendorPreset ? '<span class="preset-tag">' + t("presetTag") + "</span>" : "";
    const userIdLabel = provider.userId
      ? '<span class="userid-badge" title="' + t("labelUserId") + '">uid: ' + escapeHtml(provider.userId) + "</span>"
      : "";
    return (
      '<div class="provider-card" data-index="' +
      index +
      '">' +
      '<div class="provider-icon">' +
      protocolIcon(provider.protocol) +
      "</div>" +
      '<div class="provider-info">' +
      '<div class="provider-name">' +
      escapeHtml(provider.name) +
      " " +
      presetLabel +
      "</div>" +
      '<div class="provider-detail"><span class="protocol-badge">' +
      protocolLabel +
      "</span> " +
      (provider.models || [])
        .map(function (m) {
          return escapeHtml((provider.key ? provider.key + "/" : "") + m.id);
        })
        .filter(Boolean)
        .join(", ") +
      " " +
      userIdLabel +
      "</div>" +
      '<div class="provider-url">' +
      escapeHtml(provider.baseUrl || "") +
      "</div>" +
      '<div class="feature-toggles">' +
      '<label class="feature-toggle" title="' +
      t("labelVision") +
      '"><label class="toggle-switch"><input type="checkbox" class="toggle-vision" data-index="' +
      index +
      '"' +
      (provider.vision !== false ? " checked" : "") +
      '><span class="slider"></span></label><span>' +
      t("labelVision") +
      "</span></label>" +
      '<label class="feature-toggle" title="' +
      t("labelImageGen") +
      '"><label class="toggle-switch"><input type="checkbox" class="toggle-imagegen" data-index="' +
      index +
      '"' +
      (provider.imageGen !== false ? " checked" : "") +
      '><span class="slider"></span></label><span>' +
      t("labelImageGen") +
      "</span></label>" +
      "</div>" +
      "</div>" +
      '<div class="provider-actions">' +
      '<button class="btn-icon btn-test" title="' +
      t("testConn") +
      '" aria-label="' +
      t("testConn") +
      '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></button>' +
      '<button class="btn-icon btn-edit" title="' +
      t("edit") +
      '" aria-label="' +
      t("edit") +
      '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
      '<button class="btn-icon btn-delete" title="' +
      t("delete") +
      '" aria-label="' +
      t("delete") +
      '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
      "</div></div>"
    );
  }

  function protocolIcon(protocol) {
    if (protocol === "anthropic") {
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
    }
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>';
  }

  function bindProviderActions() {
    document.querySelectorAll(".btn-test").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        testProvider(getCardIndex(e.target));
      });
    });
    document.querySelectorAll(".toggle-vision").forEach((cb) => {
      cb.addEventListener("change", async (e) => {
        const idx = getCardIndex(e.target);
        providers[idx].vision = e.target.checked;
        if (api) {
          await api.saveProviders(providers);
        }
      });
    });
    document.querySelectorAll(".toggle-imagegen").forEach((cb) => {
      cb.addEventListener("change", async (e) => {
        const idx = getCardIndex(e.target);
        providers[idx].imageGen = e.target.checked;
        if (api) {
          await api.saveProviders(providers);
        }
      });
    });
  }

  function getCardIndex(el) {
    return Number(el.closest(".provider-card").dataset.index);
  }

  async function deleteProvider(index) {
    const name = providers[index].name;
    if (!confirm(t("confirmDelete", { name }))) return;
    providers.splice(index, 1);
    if (api) {
      await api.saveProviders(providers);
    }
    renderProviders();
    renderQuickstart();
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
    showDialog({
      title: t("dialogAddTitle"),
      name: "",
      protocol: "openai-chat",
      baseUrl: "",
      apiKey: "",
      models: [{ id: "", maxOutputK: 64, maxContextK: 128 }],
      userId: "",
      vision: true,
      imageGen: true,
    });
  });

  function openEditDialog(index) {
    editingIndex = index;
    const p = providers[index];
    showDialog({
      title: t("dialogEditTitle"),
      name: p.name,
      key: p.key || "",
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      models:
        p.models && p.models.length > 0
          ? p.models.map(function (m) {
              return Object.assign({}, m);
            })
          : [{ id: "", maxOutputK: 64, maxContextK: 128 }],
      userId: p.userId || "",
      vision: p.vision !== false,
      imageGen: p.imageGen !== false,
      preset: p.preset || "",
    });
  }

  function renderModelRows(models) {
    return models
      .map(function (m, i) {
        return (
          '<div class="model-row" data-mi="' +
          i +
          '">' +
          '<input type="text" class="model-id" value="' +
          escapeAttr(m.id || "") +
          '" placeholder="' +
          t("placeholderModel") +
          '">' +
          '<input type="number" class="model-max-out" value="' +
          (m.maxOutputK || 64) +
          '" placeholder="' +
          t("labelMaxOutput") +
          '" min="1" title="' +
          t("labelMaxOutput") +
          '">' +
          '<input type="number" class="model-max-ctx" value="' +
          (m.maxContextK || 128) +
          '" placeholder="' +
          t("labelMaxContext") +
          '" min="1" title="' +
          t("labelMaxContext") +
          '">' +
          '<button type="button" class="btn-icon btn-remove-model" title="' +
          t("btnRemoveModel") +
          '">&times;</button>' +
          "</div>"
        );
      })
      .join("");
  }

  function bindModelRowEvents() {
    var dialog = document.getElementById("provider-dialog");
    if (!dialog) return;
    dialog.querySelectorAll(".btn-remove-model").forEach(function (btn) {
      btn.onclick = function () {
        var list = document.getElementById("dlg-models-list");
        if (list.children.length <= 1) return;
        btn.closest(".model-row").remove();
      };
    });
  }

  function showDialog(data) {
    let dialog = document.getElementById("provider-dialog");
    if (!dialog) {
      dialog = document.createElement("div");
      dialog.id = "provider-dialog";
      dialog.className = "dialog-overlay";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      document.body.appendChild(dialog);
    }

    selectedPreset = data.preset || null;

    // Determine which protocols to offer for this preset.
    // If protocols is set, only those options; otherwise show both.
    var presetProtocols = null;
    var presetObj = selectedPreset
      ? PRESETS.find(function (p) {
          return p.id === selectedPreset;
        })
      : null;
    if (presetObj && presetObj.protocols && presetObj.protocols.length > 0) {
      presetProtocols = presetObj.protocols;
    }

    var protocolOptionsHtml = "";
    if (presetProtocols) {
      protocolOptionsHtml = presetProtocols
        .map(function (proto) {
          var label = proto === "anthropic" ? t("protocolAnthropic") : t("protocolOpenAI");
          var sel = data.protocol === proto ? " selected" : "";
          return '<option value="' + proto + '"' + sel + ">" + label + "</option>";
        })
        .join("");
    } else {
      protocolOptionsHtml =
        '<option value="openai-chat"' +
        (data.protocol === "openai-chat" ? " selected" : "") +
        ">" +
        t("protocolOpenAI") +
        '</option><option value="anthropic"' +
        (data.protocol === "anthropic" ? " selected" : "") +
        ">" +
        t("protocolAnthropic") +
        "</option>";
    }
    var protocolDisabled = presetProtocols && presetProtocols.length === 1;
    var protocolHint = protocolDisabled ? ' <span class="protocol-fixed-hint">(' + t("presetFixed") + ")</span>" : "";

    dialog.setAttribute("aria-labelledby", "dialog-title");

    dialog.innerHTML =
      '<div class="dialog">' +
      '<div class="dialog-header"><h2 id="dialog-title">' +
      data.title +
      '</h2><button class="btn-close" id="dialog-close" aria-label="' +
      t("cancel") +
      '">&times;</button></div>' +
      '<div class="dialog-body">' +
      '<div class="preset-buttons">' +
      '<button class="btn-preset btn-preset-custom" data-preset="custom">' +
      t("presetCustom") +
      "</button>" +
      PRESETS.map(function (p, i) {
        return '<button class="btn-preset" data-preset="' + i + '">' + escapeHtml(p.name) + "</button>";
      }).join("") +
      "</div>" +
      '<div class="form-group"><label for="dlg-name">' +
      t("labelName") +
      '</label><input type="text" id="dlg-name" value="' +
      escapeAttr(data.name) +
      '" placeholder="' +
      t("placeholderName") +
      '"></div>' +
      '<div class="form-group"><label for="dlg-key">' +
      t("labelKey") +
      ' <small style="color:var(--text-muted);font-weight:400">(' +
      t("labelKeyHint") +
      ')</small></label><input type="text" id="dlg-key" value="' +
      escapeAttr(data.key || "") +
      '" placeholder="' +
      t("placeholderKey") +
      '" class="dlg-key-input"></div>' +
      '<div class="form-group"><label for="dlg-protocol">' +
      t("labelProtocol") +
      protocolHint +
      '</label><select id="dlg-protocol"' +
      (protocolDisabled ? " disabled" : "") +
      ">" +
      protocolOptionsHtml +
      "</select></div>" +
      '<div class="form-group"><label for="dlg-baseurl">' +
      t("labelBaseUrl") +
      '</label><input type="text" id="dlg-baseurl" value="' +
      escapeAttr(data.baseUrl) +
      '" placeholder="' +
      t("placeholderBaseUrl") +
      '"></div>' +
      '<div class="form-group"><label for="dlg-apikey">' +
      t("labelApiKey") +
      '</label><input type="password" id="dlg-apikey" value="' +
      escapeAttr(data.apiKey) +
      '" placeholder="' +
      t("placeholderApiKey") +
      '"></div>' +
      '<div class="form-group"><label>' +
      t("labelModel") +
      '</label><div id="dlg-models-list">' +
      renderModelRows(data.models || [{ id: "", maxOutputK: 64, maxContextK: 128 }]) +
      '</div><button type="button" class="btn-add-model" style="margin-top:6px">' +
      t("btnAddModel") +
      "</button></div>" +
      '<div class="form-group"><label for="dlg-userid">' +
      t("labelUserId") +
      ' <small style="color:var(--text-muted);font-weight:400">(' +
      t("labelUserIdHint") +
      ')</small></label><input type="text" id="dlg-userid" value="' +
      escapeAttr(data.userId || "") +
      '" placeholder="' +
      t("placeholderUserId") +
      '"></div>' +
      '<div class="dialog-features">' +
      '<div class="dialog-feature"><label for="dlg-vision">' +
      t("labelVision") +
      '</label><label class="toggle-switch"><input type="checkbox" id="dlg-vision"' +
      (data.vision !== false ? " checked" : "") +
      '><span class="slider"></span></label></div>' +
      '<div class="dialog-feature"><label for="dlg-imagegen">' +
      t("labelImageGen") +
      '</label><label class="toggle-switch"><input type="checkbox" id="dlg-imagegen"' +
      (data.imageGen !== false ? " checked" : "") +
      '><span class="slider"></span></label></div>' +
      "</div>" +
      "</div>" +
      '<div class="dialog-footer">' +
      '<button class="btn btn-secondary" id="dlg-cancel">' +
      t("cancel") +
      "</button>" +
      '<button class="btn btn-primary" id="dlg-save">' +
      t("save") +
      "</button>" +
      "</div></div>";

    // Remove old overlay click listener before adding a new one
    if (dialog._overlayClickHandler) {
      dialog.removeEventListener("mousedown", dialog._overlayClickHandler);
    }
    dialog._overlayClickHandler = function (e) {
      if (e.target === dialog) closeDialog();
    };
    dialog.addEventListener("mousedown", dialog._overlayClickHandler);

    // Buttons and event wiring
    dialog.querySelector("#dialog-close").addEventListener("click", closeDialog);
    dialog.querySelector("#dlg-cancel").addEventListener("click", closeDialog);
    dialog.querySelector("#dlg-save").addEventListener("click", saveDialog);
    dialog.querySelectorAll(".btn-preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        dialog.querySelectorAll(".btn-preset").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        if (btn.dataset.preset === "custom") {
          selectedPreset = null;
          document.getElementById("dlg-name").value = "";
          document.getElementById("dlg-protocol").value = "openai-chat";
          document.getElementById("dlg-protocol").disabled = false;
          document.getElementById("dlg-baseurl").value = "";
          document.getElementById("dlg-apikey").value = "";
          document.getElementById("dlg-models-list").innerHTML = renderModelRows([{ id: "", maxOutputK: 64, maxContextK: 128 }]);
          bindModelRowEvents();
          var protoLabel = document.querySelector('label[for="dlg-protocol"]');
          if (protoLabel) {
            var existingHint = protoLabel.querySelector(".protocol-fixed-hint");
            if (existingHint) existingHint.remove();
          }
        } else {
          const preset = PRESETS[Number(btn.dataset.preset)];
          selectedPreset = preset.id || null;
          document.getElementById("dlg-name").value = preset.name || "";
          document.getElementById("dlg-protocol").value = preset.protocol || "openai-chat";
          document.getElementById("dlg-baseurl").value = preset.baseUrl || "";
          document.getElementById("dlg-apikey").value = "";
          var presetModels = (preset.models || []).map(function (m) {
            return typeof m === "string"
              ? { id: m, maxOutputK: 64, maxContextK: 128 }
              : Object.assign({ maxOutputK: 64, maxContextK: 128 }, m);
          });
          if (presetModels.length === 0) presetModels = [{ id: "", maxOutputK: 64, maxContextK: 128 }];
          document.getElementById("dlg-models-list").innerHTML = renderModelRows(presetModels);
          bindModelRowEvents();
          var presetProtos = preset.protocols;
          var singleProto = presetProtos && presetProtos.length === 1;
          var protoSelect = document.getElementById("dlg-protocol");
          if (protoSelect) {
            protoSelect.disabled = singleProto;
            protoSelect.value = preset.protocol || "openai-chat";
          }
          // Show/hide fixed hint in label
          var protoLabel2 = document.querySelector('label[for="dlg-protocol"]');
          if (protoLabel2) {
            var existingHint2 = protoLabel2.querySelector(".protocol-fixed-hint");
            if (existingHint2) existingHint2.remove();
            if (singleProto) {
              var hint = document.createElement("span");
              hint.className = "protocol-fixed-hint";
              hint.textContent = " (" + t("presetFixed") + ")";
              protoLabel2.appendChild(hint);
            }
          }
        }
      });
    });

    // Highlight the active preset button when editing
    if (selectedPreset) {
      const presetBtns = dialog.querySelectorAll('.btn-preset:not([data-preset="custom"])');
      presetBtns.forEach((btn) => {
        const preset = PRESETS[Number(btn.dataset.preset)];
        if (preset && preset.id === selectedPreset) {
          btn.classList.add("active");
        }
      });
    } else {
      const customBtn = dialog.querySelector('.btn-preset[data-preset="custom"]');
      if (customBtn) customBtn.classList.add("active");
    }

    // Auto-generate key from name
    var keyInput = dialog.querySelector("#dlg-key");
    var nameInput = dialog.querySelector("#dlg-name");
    if (keyInput && nameInput && !data.key) {
      nameInput.addEventListener("input", function () {
        if (keyInput.dataset.touched) return;
        if (api) {
          var existingKeys = api.getExistingKeys(
            providers.filter(function (_, i) {
              return i !== editingIndex;
            }),
          );
          keyInput.value = api.generateKey(nameInput.value.trim(), existingKeys);
        }
      });
      keyInput.addEventListener("input", function () {
        keyInput.dataset.touched = "1";
      });
    }

    // Auto-switch baseUrl when protocol changes (vendor variant support)
    const protoSelect = dialog.querySelector("#dlg-protocol");
    protoSelect.addEventListener("change", function () {
      if (!selectedPreset || !api || !api.getVariantBaseUrl) return;
      const fakeProvider = { preset: selectedPreset, baseUrl: "" };
      api.getVariantBaseUrl(fakeProvider, protoSelect.value).then(function (url) {
        if (url) document.getElementById("dlg-baseurl").value = url;
      });
    });

    dialog.querySelector("#dlg-save").addEventListener("click", saveDialog);

    dialog.addEventListener("mousedown", dialog._overlayClickHandler);
    document.addEventListener("keydown", handleDialogKeydown);

    bindModelRowEvents();

    dialog.querySelector(".btn-add-model").addEventListener("click", function () {
      var list = document.getElementById("dlg-models-list");
      var div = document.createElement("div");
      div.className = "model-row";
      div.dataset.mi = list.children.length;
      div.innerHTML =
        '<input type="text" class="model-id" value="" placeholder="' +
        t("placeholderModel") +
        '">' +
        '<input type="number" class="model-max-out" value="64" placeholder="' +
        t("labelMaxOutput") +
        '" min="1" title="' +
        t("labelMaxOutput") +
        '">' +
        '<input type="number" class="model-max-ctx" value="128" placeholder="' +
        t("labelMaxContext") +
        '" min="1" title="' +
        t("labelMaxContext") +
        '">' +
        '<button type="button" class="btn-icon btn-remove-model" title="' +
        t("btnRemoveModel") +
        '">&times;</button>';
      list.appendChild(div);
      bindModelRowEvents();
      div.querySelector(".model-id").focus();
    });

    // Show immediately — innerHTML is already parsed, display+layout are synchronous
    var prevFocus = document.activeElement;
    dialog._prevFocus = prevFocus;
    dialog.style.display = "flex";
    var firstInput = dialog.querySelector("#dlg-name");
    if (firstInput) firstInput.focus();
  }

  function handleDialogKeydown(e) {
    if (e.key === "Escape") {
      closeDialog();
    }
  }

  function closeDialog() {
    const dialog = document.getElementById("provider-dialog");
    if (!dialog) return;
    dialog.style.display = "none";
    selectedPreset = null;
    document.removeEventListener("keydown", handleDialogKeydown);
    if (dialog._prevFocus && typeof dialog._prevFocus.focus === "function") {
      dialog._prevFocus.focus();
      dialog._prevFocus = null;
    }
  }

  async function saveDialog() {
    try {
      const name = document.getElementById("dlg-name").value.trim();
      const protocol = document.getElementById("dlg-protocol").value;
      const baseUrl = document.getElementById("dlg-baseurl").value.trim();
      const apiKey = document.getElementById("dlg-apikey").value.trim();
      const userId = document.getElementById("dlg-userid").value.trim();
      const vision = document.getElementById("dlg-vision").checked;
      const imageGen = document.getElementById("dlg-imagegen").checked;

      var models = [];
      document.querySelectorAll("#dlg-models-list .model-row").forEach(function (row) {
        var id = row.querySelector(".model-id").value.trim();
        var maxOut = parseInt(row.querySelector(".model-max-out").value, 10) || 64;
        var maxCtx = parseInt(row.querySelector(".model-max-ctx").value, 10) || 128;
        if (id) models.push({ id: id, maxOutputK: maxOut, maxContextK: maxCtx });
      });

      if (!name) {
        showToast(t("toastNameRequired"), "error");
        return;
      }
      if (!baseUrl) {
        showToast(t("toastUrlRequired"), "error");
        return;
      }
      if (!apiKey) {
        showToast(t("toastKeyRequired"), "error");
        return;
      }
      if (models.length === 0) {
        showToast(t("toastModelRequired"), "error");
        return;
      }

      var key = document.getElementById("dlg-key").value.trim();
      if (!key && api) {
        var existingKeys = api.getExistingKeys(
          providers.filter(function (_, i) {
            return i !== editingIndex;
          }),
        );
        key = api.generateKey(name, existingKeys);
      }
      if (!key) key = name.toLowerCase().replace(/[^a-z0-9\-_]/g, "") || "provider";

      const entry = { name, key, protocol, baseUrl, apiKey, models, vision, imageGen, preset: selectedPreset || "" };
      if (userId) entry.userId = userId;
      if (editingIndex >= 0) {
        providers[editingIndex] = entry;
      } else {
        providers.push(entry);
      }

      if (api) {
        await api.saveProviders(providers);
      }
      renderProviders();
      renderQuickstart();
    } catch (err) {
      showToast("Save failed: " + (err.message || "Unknown error"), "error");
    } finally {
      closeDialog();
    }
  }

  // Toast
  function showToast(message, type) {
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.setAttribute("aria-live", "assertive");
      container.setAttribute("role", "status");
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = "toast toast-" + (type || "info");
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("fade-out");
    }, 2500);
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  // Logs
  const logEntries = [];
  const MAX_VISIBLE = 50; // collapse older entries

  document.getElementById("btn-clear-logs").addEventListener("click", () => {
    logEntries.length = 0;
    renderLogs();
  });

  function renderLogs() {
    const list = document.getElementById("log-list");
    if (logEntries.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>' + t("noLogs") + "</p></div>";
      return;
    }

    // Newest first
    const visible = logEntries.length > MAX_VISIBLE ? logEntries.slice(-MAX_VISIBLE) : logEntries;
    const olderCount = logEntries.length - visible.length;

    let html = "";
    if (olderCount > 0) {
      html +=
        '<div class="log-fold" id="log-fold-older"><span>' +
        t("logOlderEntries", { count: olderCount }) +
        ' <a href="#" id="btn-show-older">' +
        t("logShowAll") +
        "</a></span></div>";
    }

    // Render in reverse (newest first), newest at top
    for (let i = visible.length - 1; i >= 0; i--) {
      const e = visible[i];
      html +=
        '<div class="log-entry"><span class="log-time">' +
        e.time +
        '</span><span class="log-level ' +
        e.level +
        '">' +
        e.level +
        '</span><span class="log-message">' +
        escapeHtml(e.message) +
        "</span></div>";
    }

    list.innerHTML = html;

    // Bind "show all" click
    const showAllBtn = document.getElementById("btn-show-older");
    if (showAllBtn) {
      showAllBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        renderAllLogs();
      });
    }
  }

  function renderAllLogs() {
    const list = document.getElementById("log-list");
    let html = "";
    // Reverse: newest first
    for (let i = logEntries.length - 1; i >= 0; i--) {
      const e = logEntries[i];
      html +=
        '<div class="log-entry"><span class="log-time">' +
        e.time +
        '</span><span class="log-level ' +
        e.level +
        '">' +
        e.level +
        '</span><span class="log-message">' +
        escapeHtml(e.message) +
        "</span></div>";
    }
    list.innerHTML = html;
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

  // Quick start page
  var _qsSelectedModel = null;

  function getDisplayEndpoint(host, port) {
    return "http://localhost:" + (port || 8629) + "/v1";
  }

  function updateQuickstartTemplates(model) {
    _qsSelectedModel = model;
    var endpoint = getDisplayEndpoint(settings.host, settings.port);

    var tags = document.querySelectorAll(".qs-model-tag");
    for (var ti = 0; ti < tags.length; ti++) {
      if (tags[ti].getAttribute("data-model") === model) {
        tags[ti].classList.add("qs-model-tag-active");
      } else {
        tags[ti].classList.remove("qs-model-tag-active");
      }
    }

    var ccswitchEl = document.getElementById("qs-ccswitch-config");
    if (ccswitchEl) {
      ccswitchEl.textContent = 'wire_api = "responses"\nbase_url = "' + endpoint + '"\nmodel = "' + model + '"';
    }

    var tomlEl = document.getElementById("qs-toml-config");
    if (tomlEl) {
      tomlEl.textContent =
        'model_provider = "codex-bridge"\nmodel = "' +
        model +
        '"\nmodel_reasoning_effort = "high"\ndisable_response_storage = true\npreferred_auth_method = "chatgpt"\n\n[model_providers.codex-bridge]\nname = "codex-bridge"\nwire_api = "responses"\nrequires_openai_auth = true\nbase_url = "' +
        endpoint +
        '"\n\n[windows]\nsandbox = "elevated"';
    }

    var curlEl = document.getElementById("quickstart-curl");
    if (curlEl) {
      curlEl.textContent =
        'Invoke-RestMethod -Uri "' +
        endpoint +
        '/responses" -Method Post -ContentType "application/json" -Body \'{"model":"' +
        model +
        '","input":"hello","stream":true}\'';
    }
  }

  function renderQuickstart() {
    var endpoint = getDisplayEndpoint(settings.host, settings.port);
    var endpointEl = document.getElementById("quickstart-endpoint");
    if (endpointEl) endpointEl.textContent = endpoint;

    var lanHint = document.getElementById("quickstart-lan-hint");
    if (lanHint) lanHint.style.display = settings.host === "0.0.0.0" ? "block" : "none";

    var modelsEl = document.getElementById("quickstart-models");
    if (!modelsEl) return;
    var firstModel = "MODEL_NAME";
    if (!providers || providers.length === 0) {
      modelsEl.innerHTML = "<p>" + t("noProviders") + "</p>";
    } else {
      modelsEl.innerHTML = providers
        .map(function (p) {
          return (p.models || [])
            .map(function (m) {
              var fullId = (p.key ? p.key + "/" : "") + (m.id || "?");
              return (
                '<span class="qs-model-tag" data-model="' +
                escapeHtml(fullId) +
                '" title="' +
                escapeHtml(fullId) +
                '">' +
                escapeHtml(fullId) +
                "</span>"
              );
            })
            .join("");
        })
        .join("");
      for (var pi = 0; pi < providers.length; pi++) {
        if (providers[pi].models && providers[pi].models[0] && providers[pi].models[0].id) {
          firstModel = (providers[pi].key ? providers[pi].key + "/" : "") + providers[pi].models[0].id;
          break;
        }
      }
    }

    var selected = _qsSelectedModel && modelsEl.querySelector('[data-model="' + _qsSelectedModel + '"]') ? _qsSelectedModel : firstModel;
    updateQuickstartTemplates(selected);
  }

  document.getElementById("quickstart-models").addEventListener("click", function (e) {
    var tag = e.target.closest(".qs-model-tag");
    if (!tag) return;
    updateQuickstartTemplates(tag.getAttribute("data-model"));
  });

  function setupCopyButton(btnId, sourceId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener("click", function () {
      var el = document.getElementById(sourceId);
      if (!el) return;
      navigator.clipboard
        .writeText(el.textContent)
        .then(function () {
          showToast(t("quickstartCopied"), "success");
        })
        .catch(function () {
          showToast("Copy failed", "error");
        });
    });
  }

  setupCopyButton("btn-copy-curl", "quickstart-curl");
  setupCopyButton("btn-copy-ccswitch", "qs-ccswitch-config");
  setupCopyButton("btn-copy-toml", "qs-toml-config");

  // Open URL in system browser
  function openLink(url) {
    diag("openLink: url=" + url);
    if (!api) {
      diag("openLink: api is NULL");
      return;
    }
    if (!api.openExternal) {
      diag("openLink: api.openExternal is " + typeof api.openExternal);
      return;
    }
    try {
      api
        .openExternal(url)
        .then(function () {
          diag("openLink: resolved ok");
        })
        .catch(function (e) {
          diag("openLink: ERROR " + (e.message || e));
        });
    } catch (e) {
      diag("openLink: SYNC ERROR " + (e.message || e));
    }
  }
  document.getElementById("link-github").addEventListener("click", () => {
    openLink("https://github.com/LeenixP/Codex-Bridge");
  });
  document.getElementById("link-issues").addEventListener("click", () => {
    openLink("https://github.com/LeenixP/Codex-Bridge/issues");
  });

  // Check for updates
  document.getElementById("btn-check-update").addEventListener("click", async () => {
    const statusEl = document.getElementById("update-status");
    diag("checkUpdate: clicked");
    if (!api || !api.checkForUpdates) {
      diag("checkUpdate: api or checkForUpdates missing, api=" + typeof api + " check=" + (api ? typeof api.checkForUpdates : "N/A"));
      statusEl.textContent = t("updateError") + " (no IPC)";
      statusEl.className = "update-status error";
      return;
    }
    statusEl.textContent = t("updateChecking");
    statusEl.className = "update-status";
    try {
      diag("checkUpdate: calling api.checkForUpdates...");
      const result = await api.checkForUpdates();
      diag("checkUpdate: result=" + JSON.stringify(result));
      if (result.ok && result.latest === null) {
        statusEl.textContent = t("updateNoRelease");
        statusEl.className = "update-status latest";
      } else if (result.ok && result.newer) {
        statusEl.textContent = t("updateAvailable", { version: result.latest });
        statusEl.className = "update-status available";
        statusEl.style.cursor = "pointer";
        statusEl.title = result.url || "";
        statusEl.onclick = () => openLink(result.url);
      } else if (result.ok) {
        statusEl.textContent = t("updateLatest");
        statusEl.className = "update-status latest";
      } else {
        statusEl.textContent = result.message || t("updateError");
        statusEl.className = "update-status error";
      }
    } catch (e) {
      diag("checkUpdate: EXCEPTION " + (e.message || e));
      statusEl.textContent = t("updateError") + ": " + (e.message || e);
      statusEl.className = "update-status error";
    }
  });

  // Boot
  init();
})();
