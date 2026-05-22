#!/usr/bin/env node
"use strict";

/**
 * Generate PNG and ICO icons from app.svg.
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

const minimalPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

if (!checkSharp()) {
  console.log("sharp not found. Creating placeholder PNGs.");
  fs.writeFileSync(path.join(iconsDir, "app.png"), minimalPng);
  fs.writeFileSync(path.join(iconsDir, "tray.png"), minimalPng);
  console.log("Placeholder PNGs created.");
  process.exit(0);
}

const sharp = require("sharp");
const appSvg = path.join(iconsDir, "app.svg");
const traySvg = path.join(iconsDir, "tray.svg");

function buildIco(pngBuffers, sizes) {
  // pngBuffers: array of {size, buffer} sorted by size ascending
  const count = pngBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);       // type: 1 = ICO
  header.writeUInt16LE(count, 4);   // image count

  const dirEntries = [];
  let dataOffset = dirSize;
  const imageDatas = [];

  for (let i = 0; i < count; i++) {
    const buf = pngBuffers[i];
    const size = sizes[i];
    const entry = Buffer.alloc(dirEntrySize);
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;
    entry.writeUInt8(w, 0);          // width (0 = 256)
    entry.writeUInt8(h, 1);          // height (0 = 256)
    entry.writeUInt8(0, 2);          // palette
    entry.writeUInt8(0, 3);          // reserved
    entry.writeUInt16LE(1, 4);       // planes
    entry.writeUInt16LE(32, 6);      // bpp
    entry.writeUInt32LE(buf.length, 8);  // image size
    entry.writeUInt32LE(dataOffset, 12); // offset
    dirEntries.push(entry);
    imageDatas.push(buf);
    dataOffset += buf.length;
  }

  return Buffer.concat([header, ...dirEntries, ...imageDatas]);
}

async function generate() {
  const appSizes = [16, 32, 48, 256];

  // Generate individual PNGs for each size
  const pngBuffers = [];
  for (const size of appSizes) {
    const buf = await sharp(appSvg).resize(size, size).png().toBuffer();
    pngBuffers.push(buf);
    if (size === 256) {
      fs.writeFileSync(path.join(iconsDir, "app.png"), buf);
    }
  }
  console.log("app.png (256x256)");

  // Build multi-size ICO
  const icoBuf = buildIco(pngBuffers, appSizes);
  fs.writeFileSync(path.join(iconsDir, "app.ico"), icoBuf);
  console.log("app.ico (16/32/48/256)");

  // App icon: 512x512 PNG (for macOS)
  await sharp(appSvg).resize(512, 512).png().toFile(path.join(iconsDir, "app-512.png"));
  console.log("app-512.png (512x512)");

  // Tray icon: 16x16
  await sharp(traySvg).resize(16, 16).png().toFile(path.join(iconsDir, "tray.png"));
  console.log("tray.png (16x16)");
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});