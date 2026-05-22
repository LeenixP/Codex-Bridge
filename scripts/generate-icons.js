#!/usr/bin/env node
"use strict";

/**
 * Generate PNG and ICO icons from SVG sources.
 * Requires: sharp (in devDependencies)
 *
 * Usage: node scripts/generate-icons.js
 */

const path = require("node:path");
const fs = require("node:fs");

const iconsDir = path.join(__dirname, "..", "src", "ui", "assets", "icons");

function checkSharp() {
  try {
    require.resolve("sharp");
    return true;
  } catch {
    return false;
  }
}

if (!checkSharp()) {
  console.error("sharp is required. Run: npm install");
  process.exit(1);
}

const sharp = require("sharp");
const appSvg = path.join(iconsDir, "app.svg");
const traySvg = path.join(iconsDir, "tray.svg");

/**
 * Build a multi-resolution ICO file from PNG buffers.
 * pngBuffers: array of { size, buffer } sorted by size ascending.
 */
function buildIco(entries) {
  const count = entries.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirParts = [];
  const dataParts = [];
  let offset = dirSize;

  for (const { size, buffer } of entries) {
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(w, 0);
    entry.writeUInt8(h, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirParts.push(entry);
    dataParts.push(buffer);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...dirParts, ...dataParts]);
}

async function generate() {
  // --- Windows: ICO with full size set ---
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoEntries = [];
  for (const size of icoSizes) {
    const buf = await sharp(appSvg).resize(size, size).png().toBuffer();
    icoEntries.push({ size, buffer: buf });
  }
  const icoBuf = buildIco(icoEntries);
  fs.writeFileSync(path.join(iconsDir, "app.ico"), icoBuf);
  console.log("app.ico (" + icoSizes.join("/") + ")");

  // --- Linux: 512x512 PNG ---
  await sharp(appSvg).resize(512, 512).png().toFile(path.join(iconsDir, "app.png"));
  console.log("app.png (512x512)");

  // --- macOS: 512x512 PNG (electron-builder converts to .icns) ---
  await sharp(appSvg).resize(512, 512).png().toFile(path.join(iconsDir, "app-512.png"));
  console.log("app-512.png (512x512)");

  // --- Tray: 16x16 + 32x32 (for HiDPI) ---
  await sharp(traySvg).resize(16, 16).png().toFile(path.join(iconsDir, "tray.png"));
  console.log("tray.png (16x16)");

  await sharp(traySvg).resize(32, 32).png().toFile(path.join(iconsDir, "tray@2x.png"));
  console.log("tray@2x.png (32x32)");
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
