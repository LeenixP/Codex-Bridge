"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DIST_DIR = path.join(__dirname, "..", "dist");
const version = require("../package.json").version;

const required = [
  "Codex-Switch-v" + version + "-Linux-arm64.AppImage",
  "Codex-Switch-v" + version + "-Linux-arm64.AppImage.md5",
  "Codex-Switch-v" + version + "-Linux-x86_64.AppImage",
  "Codex-Switch-v" + version + "-Linux-x86_64.AppImage.md5",
  "Codex-Switch-v" + version + "-macOS.dmg",
  "Codex-Switch-v" + version + "-macOS.dmg.md5",
  "Codex-Switch-v" + version + "-macOS.zip",
  "Codex-Switch-v" + version + "-macOS.zip.md5",
  "Codex-Switch-v" + version + "-Windows_Setup.exe",
  "Codex-Switch-v" + version + "-Windows_Setup.exe.md5",
];

function fileMd5(filePath) {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function verifyMd5(md5Name) {
  const md5Path = path.join(DIST_DIR, md5Name);
  const targetName = md5Name.slice(0, -4);
  const targetPath = path.join(DIST_DIR, targetName);
  const expected = fs.readFileSync(md5Path, "utf8").trim().split(/\s+/)[0];
  const actual = fileMd5(targetPath);
  if (expected !== actual) {
    throw new Error(md5Name + " does not match " + targetName);
  }
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error("dist directory does not exist");
  }

  const missing = required.filter((name) => !fs.existsSync(path.join(DIST_DIR, name)));
  if (missing.length > 0) {
    throw new Error("Missing release asset(s):\n" + missing.map((name) => "  - " + name).join("\n"));
  }

  for (const name of required.filter((item) => item.endsWith(".md5"))) {
    verifyMd5(name);
  }

  console.log("Release asset verification passed: " + required.length + " file(s)");
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
