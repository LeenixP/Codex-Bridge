"use strict";

const crypto = require("node:crypto");

function makeId(prefix) {
  return prefix + "_" + crypto.randomBytes(12).toString("hex");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function createSequence() {
  let seq = 0;
  return {
    next() {
      return seq++;
    },
  };
}

function emitSse(res, event, data) {
  res.write("event: " + event + "\n");
  res.write("data: " + JSON.stringify(data) + "\n\n");
}

module.exports = {
  makeId,
  nowSeconds,
  createSequence,
  emitSse,
};
