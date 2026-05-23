"use strict";

// Kimi (Moonshot) preset hooks — OpenAI Chat protocol.
// Used for the standard Kimi API (kimi-k2.6, etc.) via api.moonshot.cn.
//
// Kimi For Coding uses kimi-anthropic.js instead.

const KIMI_CLI_UA = "KimiCLI/1.6";

function getHeaders(_provider) {
  return {
    "User-Agent": KIMI_CLI_UA,
  };
}

// Safety net: merge consecutive system messages and strip empty ones.
// The adapter already maps developer→system and merges consecutive systems,
// but hooks run after so we double-check here.
function onMessagesBuilt(messages, _requestBody, _provider) {
  if (!Array.isArray(messages)) return messages;

  return messages.reduce(function (acc, msg) {
    if (!msg) return acc;

    // Drop empty system messages — Kimi returns 400 for these.
    if (msg.role === "system" && (!msg.content || (typeof msg.content === "string" && msg.content.trim() === ""))) {
      return acc;
    }

    // Merge consecutive system messages (safety net — adapter does this too).
    if (msg.role === "system" && acc.length > 0 && acc[acc.length - 1].role === "system") {
      var prev = acc[acc.length - 1];
      var prevContent = typeof prev.content === "string" ? prev.content : "";
      var newContent = typeof msg.content === "string" ? msg.content : "";
      prev.content = prevContent + "\n\n" + newContent;
    } else {
      acc.push(msg);
    }
    return acc;
  }, []);
}

function onUpstreamPayload(payload, _provider) {
  // Kimi requires temperature=1.0 for thinking models (k2.6, k2.5, k2-thinking).
  // The coding endpoint also enforces this.
  payload.temperature = 1.0;

  // Convert Codex reasoning_effort → Kimi thinking parameter.
  // Kimi uses {"type": "enabled"/"disabled"} — a binary switch, not a
  // multi-level effort scale like Codex.  Default in Kimi is enabled.
  var effort = payload._reasoning_effort || payload.reasoning_effort;
  if (effort === "low" || effort === "minimal") {
    payload.thinking = { type: "disabled" };
  }
  delete payload.reasoning_effort;
  delete payload._reasoning_effort;

  // Kimi For Coding may not support response_format; strip it.
  delete payload.response_format;
}

module.exports = { getHeaders, onMessagesBuilt, onUpstreamPayload };
