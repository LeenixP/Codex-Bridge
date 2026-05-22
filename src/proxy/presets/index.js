"use strict";

// --- Feature flags -----------------------------------------------------------
// Each flag is a boolean that adapters may check at runtime.
//   reasoningPassthrough   multi-turn requires reasoning_content echoed back

// --- Preset registry ---------------------------------------------------------
// Keys match provider.preset.  Protocol templates have an empty baseUrl so
// the user fills in their own endpoint.  Vendor presets pre-fill everything
// and may include hooks for vendor-specific request transforms.
//
// Adding a new vendor:
//   1. Add an entry below.
//   2. If the vendor needs special behaviour, add the feature flag or a hook.
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
    variants: {
      "openai-chat": "https://api.deepseek.com/v1",
      anthropic: "https://api.deepseek.com/anthropic",
    },
    features: {
      reasoningPassthrough: true,
    },
    hooks: {
      // DeepSeek requires reasoning_content echoed on the assistant message
      // during multi-turn conversations.
      onMessagesBuilt: function (messages, requestBody, _provider) {
        const reasoningText = extractReasoningFromBody(requestBody);
        if (!reasoningText) return messages;

        // Attach reasoning_content to the LAST assistant message found.
        // DeepSeek tolerates it on any assistant message; we attach to the
        // most recent one matching the reasoning intent.
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            messages[i].reasoning_content =
              (messages[i].reasoning_content || "") + reasoningText;
            break;
          }
        }
        return messages;
      },
    },
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

function getFeatures(provider) {
  const preset = resolvePreset(provider);
  return preset ? preset.features : {};
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
  return Object.values(presets)
    .filter(function (p) { return p.baseUrl !== ""; });
}

// ---- Internal helpers -------------------------------------------------------

function extractReasoningFromBody(requestBody) {
  const input = requestBody && requestBody.input;
  if (!Array.isArray(input)) return "";

  let text = "";
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      if (item.summary && Array.isArray(item.summary)) {
        for (let j = 0; j < item.summary.length; j++) {
          text += item.summary[j].text || "";
        }
      }
    }
  }
  return text;
}

module.exports = {
  presets,
  getPreset,
  resolvePreset,
  getFeatures,
  getHooks,
  getBaseUrl,
  getVariantBaseUrl,
  getQuickPresets,
};
