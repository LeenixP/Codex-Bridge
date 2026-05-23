"use strict";

/**
 * Parse an SSE (Server-Sent Events) stream from an undici response body.
 * Yields raw data payload strings (after "data: " prefix).
 *
 * Usage:
 *   for await (const payload of parseSSEStream(response.body)) { ... }
 */
async function* parseSSEStream(body) {
  let buffer = "";
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("data:")) {
        // Support both "data: " (standard) and "data:" (Kimi, etc.)
        const payload = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed.slice(5).trim();
        if (payload) yield payload;
      }
    }
  }
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data:")) {
      yield trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed.slice(5).trim();
    }
  }
}

module.exports = { parseSSEStream };
