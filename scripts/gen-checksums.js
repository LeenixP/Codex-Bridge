"use strict";

// Generate .md5 checksum files for every artifact in dist/.
// Run after electron-builder via the afterAllArtifactBuild hook.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DIST_DIR = path.join(__dirname, "..", "dist");

function generateMd5For(filePath) {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(filePath));
  const md5Path = filePath + ".md5";
  fs.writeFileSync(md5Path, hash.digest("hex") + "  " + path.basename(filePath) + "\n", "utf8");
  console.log("  md5  " + path.basename(md5Path));
}

function genAllChecksums() {
  if (!fs.existsSync(DIST_DIR)) return;

  const entries = fs.readdirSync(DIST_DIR);
  const skipExts = new Set([".md5", ".blockmap", ".yml", ".yaml"]);
  let count = 0;

  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    if (skipExts.has(ext)) continue;

    const fullPath = path.join(DIST_DIR, name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    generateMd5For(fullPath);
    count++;
  }

  console.log("Checksums: " + count + " file(s)");
}

genAllChecksums();
