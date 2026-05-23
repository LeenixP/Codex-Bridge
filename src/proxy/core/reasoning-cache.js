"use strict";

// In-memory LRU cache: reasoning text → { signature, ts }
//
// DeepSeek / Anthropic require thinking blocks to be echoed back with their
// cryptographic signatures in multi-turn conversations.  Codex's Responses
// API format has no signature field, so the proxy stores signatures here
// during the response phase and re-attaches them when building the next request.
//
// Eviction: LRU (max 1000 entries) + TTL (30 min).  Engines like DeepSeek
// rotate thinking keys per conversation, so stale entries must not linger.

const log = require("../../shared/logger");

const MAX_SIZE = 1000;
const TTL_MS = 30 * 60 * 1000;

const cache = new Map();

function store(text, signature) {
  if (!text || !signature) return;

  // LRU eviction before insertion
  while (cache.size >= MAX_SIZE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }

  cache.set(text, { signature, ts: Date.now() });

  const truncated = text.length > 80 ? text.slice(0, 80) + "..." : text;
  log.debug("[sig-cache] store: text_len=" + text.length + " sig_len=" + signature.length + " | " + truncated, {});
}

function get(text) {
  const entry = cache.get(text);
  if (!entry) {
    if (text) {
      const truncated = text.length > 80 ? text.slice(0, 80) + "..." : text;
      log.debug("[sig-cache] MISS: text_len=" + text.length + " cache_size=" + cache.size + " | " + truncated, {});
    }
    return null;
  }

  // TTL check
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(text);
    const truncated = text.length > 80 ? text.slice(0, 80) + "..." : text;
    log.debug("[sig-cache] EXPIRED: text_len=" + text.length + " | " + truncated, {});
    return null;
  }

  const truncated = text.length > 80 ? text.slice(0, 80) + "..." : text;
  log.debug("[sig-cache] HIT: text_len=" + text.length + " | " + truncated, {});
  return entry.signature;
}

function clear() {
  cache.clear();
}

function size() {
  return cache.size;
}

module.exports = { store, get, clear, size };
