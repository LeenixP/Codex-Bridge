"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getDataDir, ensureDir } = require("./config");

/**
 * Trace session — records full request / raw-upstream / proxy-output for a
 * single API call.  Activated only when settings.traceEnabled is true.
 *
 * Data is accumulated in memory and flushed synchronously on close(), so
 * files are guaranteed to be on disk after close() returns.
 *
 * Directory layout:
 *   {dataDir}/trace/{YYYY-MM-DD}/
 *     {HHmmss}_{model}_req.json   ← Codex incoming request body
 *     {HHmmss}_{model}_raw.txt    ← raw upstream SSE stream (or JSON body)
 *     {HHmmss}_{model}_out.txt    ← proxy-transformed SSE events sent to Codex
 */

function createTraceSession(settings, model) {
  if (!settings || !settings.traceEnabled) return null;

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
  const safeModel = (model || "unknown").replace(/[\\/:*?"<>|]/g, "_");
  const prefix = timeStr + "_" + safeModel;

  const dir = path.join(getDataDir(), "trace", dateStr);
  ensureDir(dir);

  const reqPath = path.join(dir, prefix + "_req.json");
  const rawPath = path.join(dir, prefix + "_raw.txt");
  const outPath = path.join(dir, prefix + "_out.txt");

  const rawBuf = [];
  const outBuf = [];
  let closed = false;

  return {
    logRequest(body) {
      try {
        fs.writeFileSync(reqPath, JSON.stringify(body, null, 2), "utf8");
      } catch {}
    },

    logUpstream(payload) {
      try {
        fs.writeFileSync(reqPath.replace(/_req\.json$/, "_upstream.json"), JSON.stringify(payload, null, 2), "utf8");
      } catch {}
    },

    logRawChunk(chunk) {
      if (closed) return;
      rawBuf.push(chunk);
    },

    logRawLine(line) {
      if (closed) return;
      rawBuf.push(line + "\n");
    },

    logOutEvent(eventName, data) {
      if (closed) return;
      outBuf.push("event: " + eventName + "\ndata: " + JSON.stringify(data) + "\n");
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        if (rawBuf.length > 0) fs.writeFileSync(rawPath, rawBuf.join(""), "utf8");
      } catch {}
      try {
        if (outBuf.length > 0) fs.writeFileSync(outPath, outBuf.join(""), "utf8");
      } catch {}
    },
  };
}

module.exports = { createTraceSession };
