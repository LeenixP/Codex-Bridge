"use strict";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const _LEVEL_NAMES = Object.keys(LEVELS);
void _LEVEL_NAMES;

let minLevel = "info";
let logWriter = null;

function shouldLog(level) {
  return (LEVELS[level] || 0) >= (LEVELS[minLevel] || LEVELS.info);
}

function formatMessage(level, message, meta) {
  const ts = new Date().toISOString();
  const parts = [ts, "[" + level.toUpperCase() + "]"];
  if (meta) {
    if (meta.requestId) parts.push("[" + meta.requestId + "]");
    if (meta.provider) parts.push("[" + meta.provider + "]");
  }
  parts.push(message);
  return parts.join(" ");
}

function log(level, message, meta) {
  if (!shouldLog(level)) return;
  const formatted = formatMessage(level, message, meta || {});
  if (logWriter) {
    logWriter(level, formatted, meta);
  } else {
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(formatted);
  }
}

function setLevel(level) {
  if (LEVELS[level] !== undefined) minLevel = level;
}

function onLog(callback) {
  logWriter = callback;
}

function debug(message, meta) {
  log("debug", message, meta);
}
function info(message, meta) {
  log("info", message, meta);
}
function warn(message, meta) {
  log("warn", message, meta);
}
function error(message, meta) {
  log("error", message, meta);
}

module.exports = { LEVELS, setLevel, onLog, debug, info, warn, error };
