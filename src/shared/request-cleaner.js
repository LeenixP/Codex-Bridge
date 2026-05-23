"use strict";

const CODEX_INTERNAL_KEYS = ["prompt_cache_key", "client_metadata", "include", "store", "text"];

function stripCodexFields(payload) {
  for (const key of CODEX_INTERNAL_KEYS) {
    delete payload[key];
  }
}

module.exports = { stripCodexFields };
