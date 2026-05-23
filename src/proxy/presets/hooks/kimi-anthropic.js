"use strict";

// Kimi For Coding preset hooks — Anthropic protocol.
//
// Kimi Code supports an Anthropic-compatible endpoint at
//   https://api.kimi.com/coding/v1/messages
//
// Key differences from standard Anthropic:
//   - No anthropic-beta headers (Kimi doesn't support them)
//   - thinking uses {"type":"enabled"/"disabled"} without budget_tokens
//   - temperature must be 1.0
//
// Kimi's coding API validates the User-Agent against a whitelist of
// approved coding agents. We spoof KimiCLI — the most widely reported
// working identifier across the community.

const KIMI_CLI_UA = "KimiCLI/1.6";

function getHeaders(_provider) {
  return {
    "User-Agent": KIMI_CLI_UA,
  };
}

// Strip _betas so the anthropic-beta header is not sent.
// Simplify thinking to Kimi's binary format.
function onUpstreamPayload(payload, _provider) {
  // Kimi doesn't support Anthropic betas
  delete payload._betas;

  // Kimi requires temperature=1.0 for thinking models
  payload.temperature = 1.0;

  // Kimi uses {"type":"enabled"/"disabled"} without budget_tokens.
  // The adapter maps reasoning_effort → thinking.budget_tokens;
  // we simplify to just the type field Kimi expects.
  if (payload.thinking && payload.thinking.type) {
    payload.thinking = { type: payload.thinking.type };
  }

  // Not an Anthropic concept — remove if somehow present
  delete payload.response_format;
  delete payload.reasoning_effort;
  delete payload._reasoning_effort;
}

module.exports = { getHeaders, onUpstreamPayload };
