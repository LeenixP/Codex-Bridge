"use strict";

// --- Feature flags -----------------------------------------------------------
// Each flag is a boolean that adapters may check at runtime.
//   reasoningPassthrough   multi-turn requires reasoning_content echoed back

// --- Hook modules ------------------------------------------------------------
// Each vendor preset with custom behavior loads its hooks from a dedicated file
// under hooks/<vendor>.js.  This keeps presets/index.js lean.

const deepseekHooks = require("./hooks/deepseek");

// --- Preset registry ---------------------------------------------------------
// Keys match provider.preset.  Protocol templates have an empty baseUrl so
// the user fills in their own endpoint.  Vendor presets pre-fill everything
// and may include hooks for vendor-specific request transforms.
//
// Adding a new vendor:
//   1. Create hooks/<vendor>.js exporting the hook functions.
//   2. Add an entry below referencing those hooks.
//   3. Done — no changes needed in the generic adapters.

const presets = {

  // ---- Protocol templates ---------------------------------------------------
  "openai-chat": {
    id: "openai-chat",
    name: "OpenAI Chat",
    protocol: "openai-chat",
    baseUrl: "",
    features: {},
  },

  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "",
    features: {},
  },

  // ---- Vendor presets -------------------------------------------------------
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-pro[1m]", "deepseek-v4-flash[1m]"],
    variants: {
      "openai-chat": "https://api.deepseek.com/v1",
      "anthropic": "https://api.deepseek.com/anthropic",
    },
    features: {
      reasoningPassthrough: true,
    },
    hooks: deepseekHooks,
  },
};

// ---- Query helpers ----------------------------------------------------------

function getPreset(id) {
  return presets[id] || null;
}

/** Return the preset that matches a provider, falling back to protocol preset. */
function resolvePreset(provider) {
  if (provider.preset && presets[provider.preset]) {
    return presets[provider.preset];
  }
  // Fall back to protocol-based preset
  if (provider.protocol && presets[provider.protocol]) {
    return presets[provider.protocol];
  }
  return null;
}

/** Return preset hooks (or null) for a provider. */
function getHooks(provider) {
  const preset = resolvePreset(provider);
  return (preset && preset.hooks) ? preset.hooks : null;
}

/** Return the effective baseUrl: provider config wins over preset default. */
function getBaseUrl(provider) {
  const preset = resolvePreset(provider);
  if (provider.baseUrl && provider.baseUrl.trim()) {
    return provider.baseUrl;
  }
  if (preset && preset.baseUrl) {
    return preset.baseUrl;
  }
  return "";
}

/** Return the variant baseUrl for the given protocol, falling back to default. */
function getVariantBaseUrl(provider, protocol) {
  const preset = resolvePreset(provider);
  if (preset && preset.variants && preset.variants[protocol]) {
    return preset.variants[protocol];
  }
  return getBaseUrl(provider);
}

/** List of presets suitable for the UI "quick add" buttons. */
function getQuickPresets() {
  return Object.values(presets).map(function (p) {
    return {
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      models: p.models || [],
    };
  });
}

module.exports = {
  presets,
  getPreset,
  resolvePreset,
  getHooks,
  getBaseUrl,
  getVariantBaseUrl,
  getQuickPresets,
};
