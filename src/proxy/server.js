"use strict";

const http = require("node:http");
const { loadSettings, loadProviders, getActiveProvider } = require("../shared/config");
const { orchestrate } = require("./core/orchestrator");

let server = null;
let status = "stopped";
let lastError = "";

function createProxyServer(settings, providers) {
  const port = settings.port || 8787;
  const host = settings.host || "127.0.0.1";

  status = "starting";
  lastError = "";

  server = http.createServer((req, res) => handleRequest(req, res, settings, providers));

  server.on("error", (error) => {
    status = "error";
    lastError = error.message;
    console.error("[proxy] Server error:", error.message);
  });

  server.listen(port, host, () => {
    status = "running";
    lastError = "";
    console.log("[proxy] Listening on http://" + host + ":" + port + "/v1");
  });

  return server;
}

function stopProxyServer() {
  if (!server) return;
  const closing = server;
  server = null;
  closing.close(() => {
    status = "stopped";
    console.log("[proxy] Stopped.");
  });
}

function getStatus() {
  return status;
}

function getLastError() {
  return lastError;
}

async function handleRequest(req, res, settings, providers) {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const pathname = url.pathname;

  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === "/v1/responses" && req.method === "POST") {
      await handleResponses(req, res, settings, providers);
    } else if ((pathname === "/v1/models" || pathname === "/models") && req.method === "GET") {
      handleModels(req, res, providers);
    } else if (pathname === "/healthz" || pathname === "/v1/healthz") {
      sendJson(res, 200, { ok: true, service: "codex-switch", status });
    } else {
      sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error", code: "not_found" } });
    }
  } catch (error) {
    console.error("[proxy] Request error:", error.message);
    sendJson(res, 500, { error: { message: error.message || "Internal error", type: "server_error", code: "internal_error" } });
  }
}

async function handleResponses(req, res, settings, providers) {
  const activeProvider = getActiveProvider(providers);
  if (!activeProvider) {
    sendJson(res, 503, { error: { message: "No active provider configured.", type: "server_error", code: "no_provider" } });
    return;
  }

  const body = await readBody(req);
  const requestBody = JSON.parse(body);

  await orchestrate(req, res, requestBody, activeProvider, settings);
}

function handleModels(req, res, providers) {
  const activeProvider = getActiveProvider(providers);
  const models = activeProvider && activeProvider.model ? [activeProvider.model] : [];
  sendJson(res, 200, {
    object: "list",
    data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "codex-switch" })),
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const limit = 10 * 1024 * 1024;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = {
  createProxyServer,
  stopProxyServer,
  getStatus,
  getLastError,
};