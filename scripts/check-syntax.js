"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "src");
const EXCLUDE = new Set([]);

const results = { ok: 0, fail: 0 };

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!EXCLUDE.has(e.name)) walk(full);
    } else if (e.name.endsWith(".js")) {
      checkFile(full);
    }
  }
}

function checkFile(filePath) {
  try {
    cp.execFileSync(process.execPath, ["--check", filePath], { stdio: "pipe" });
    results.ok++;
  } catch (err) {
    results.fail++;
    console.error("FAIL: " + path.relative(ROOT, filePath));
    const stderr = err.stderr ? err.stderr.toString().trim() : "";
    if (stderr) console.error("  " + stderr.split("\n").join("\n  "));
  }
}

walk(ROOT);
console.log("Syntax check: " + results.ok + " passed, " + results.fail + " failed");
process.exit(results.fail > 0 ? 1 : 0);
