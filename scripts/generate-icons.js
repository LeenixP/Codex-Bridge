#!/usr/bin/env node
"use strict";

/**
 * Generate PNG icons from app.svg for electron-builder.
 * Requires: npm install -g sharp-cli (or run via npx)
 *
 * Usage: node scripts/generate-icons.js
 *
 * This creates:
 *   src/ui/assets/icons/app.png   (256x256, for Linux)
 *   src/ui/assets/icons/tray.png  (16x16, for tray)
 *
 * For .ico and .icns, use external tools:
 *   - .ico: png2ico or electron-icon-builder
 *   - .icns: iconutil (macOS) or electron-icon-builder
 */

const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const iconsDir = path.join(__dirname, "..", "src", "ui", "assets", "icons");

function run(cmd) {
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    console.error("Command failed:", cmd);
    process.exit(1);
  }
}

function checkSharp() {
  try {
    require.resolve("sharp");
    return true;
  } catch {
    return false;
  }
}

if (!checkSharp()) {
  console.log("sharp not found. Install it: npm install sharp");
  console.log("Generating placeholder PNGs instead...");

  // Create minimal 1x1 transparent PNG as placeholder
  const minimalPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  fs.writeFileSync(path.join(iconsDir, "app.png"), minimalPng);
  fs.writeFileSync(path.join(iconsDir, "tray.png"), minimalPng);
  console.log("Placeholder PNGs created. Replace with real icons before release.");
  process.exit(0);
}

const sharp = require("sharp");
const appSvg = path.join(iconsDir, "app.svg");
const traySvg = path.join(iconsDir, "tray.svg");

async function generate() {
  await sharp(appSvg).resize(256, 256).png().toFile(path.join(iconsDir, "app.png"));
  console.log("Created app.png (256x256)");

  await sharp(traySvg).resize(16, 16).png().toFile(path.join(iconsDir, "tray.png"));
  console.log("Created tray.png (16x16)");

  // Also create 512x512 for high-DPI
  await sharp(appSvg).resize(512, 512).png().toFile(path.join(iconsDir, "app-512.png"));
  console.log("Created app-512.png (512x512)");
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
