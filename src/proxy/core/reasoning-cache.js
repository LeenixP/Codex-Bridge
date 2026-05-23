"use strict";

// In-memory cache: reasoning text → signature
//
// DeepSeek / Anthropic require thinking blocks to be echoed back with their
// cryptographic signatures in multi-turn conversations.  Codex's Responses
// API format has no signature field, so the proxy stores signatures here
// during the response phase and re-attaches them when building the next request.

const log = require("../../shared/logger");

const cache = new Map();

function store(text, signature) {
  if (text && signature) {
    const truncated = text.length > 80 ? text.slice(0, 80) + "..." : text;
    log.debug("[sig-cache] store: text_len=" + text.length + " sig_len=" + signature.length + " | " + truncated, {});
    cache.set(text, signature);
  }
}

function get(text) {
  const sig = cache.get(text) || null;
  if (sig) {
    const truncated = text.length > 80 ? text.slice(0, 80) + "..." : text;
    log.debug("[sig-cache] HIT: text_len=" + text.length + " | " + truncated, {});
  } else if (text) {
    const truncated = text.length > 80 ? text.slice(0, 80) + "..." : text;
    log.debug("[sig-cache] MISS: text_len=" + text.length + " cache_size=" + cache.size + " | " + truncated, {});
  }
  return sig;
}

module.exports = { store, get };
