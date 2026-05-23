"use strict";

// In-memory LRU response store for Codex Responses API
// Supports GET/DELETE /v1/responses/:id and GET /v1/responses/:id/input_items
// Required by Codex for multi-turn conversation continuation (previous_response_id)

const MAX_ENTRIES = 500;
const TTL_MS = 60 * 60 * 1000; // 1 hour

const store = new Map();

function set(id, data) {
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  store.set(id, {
    response: data.response,
    inputItems: data.inputItems || [],
    createdAt: Date.now(),
  });
}

function get(id) {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  return entry.response;
}

function getInputItems(id) {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  return entry.inputItems;
}

function remove(id) {
  return store.delete(id);
}

function size() {
  return store.size;
}

module.exports = { set, get, getInputItems, remove, size };
