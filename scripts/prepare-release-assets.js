"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DIST_DIR = path.join(__dirname, "..", "dist");

function md5For(filePath) {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function renameIfExists(fromName, toName) {
  const fromPath = path.join(DIST_DIR, fromName);
  const toPath = path.join(DIST_DIR, toName);
  if (!fs.existsSync(fromPath) || fromPath === toPath) return false;
  if (fs.existsSync(toPath)) fs.unlinkSync(toPath);
  fs.renameSync(fromPath, toPath);
  return true;
}

function writeMd5(fileName) {
  const filePath = path.join(DIST_DIR, fileName);
  if (!fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath + ".md5", md5For(filePath) + "  " + fileName + "\n", "utf8");
  return true;
}

function prepare() {
  if (!fs.existsSync(DIST_DIR)) return;

  const version = require("../package.json").version;
  const linuxX64 = "Codex-Switch-v" + version + "-Linux-x64.AppImage";
  const linuxX8664 = "Codex-Switch-v" + version + "-Linux-x86_64.AppImage";

  if (renameIfExists(linuxX64, linuxX8664)) {
    console.log("  rename  " + linuxX64 + " -> " + linuxX8664);
  }

  const md5Targets = [
    linuxX8664,
    "Codex-Switch-v" + version + "-Linux-arm64.AppImage",
    "Codex-Switch-v" + version + "-Windows_Setup.exe",
    "Codex-Switch-v" + version + "-macOS.dmg",
    "Codex-Switch-v" + version + "-macOS.zip",
  ];

  let count = 0;
  for (const name of md5Targets) {
    if (writeMd5(name)) {
      console.log("  md5  " + name + ".md5");
      count++;
    }
  }

  console.log("Release asset preparation: " + count + " checksum file(s)");
}

prepare();
