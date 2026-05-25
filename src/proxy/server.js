"use strict";

const http = require("node:http");
const { getProviderByModel } = require("../shared/config");
const { orchestrate } = require("./core/orchestrator");
const responseStore = require("./core/response-store");
const log = require("../shared/logger");

let server = null;
let status = "stopped";
let lastError = "";
let activeSettings = null;
let _activeProviders = null;

function createProxyServer(settings, providers) {
  const port = settings.port ?? 8629;
  const host = settings.host || "127.0.0.1";

  status = "starting";
  lastError = "";

  activeSettings = settings;
  _activeProviders = providers;

  server = http.createServer((req, res) => handleRequest(req, res, settings, providers));

  // Log every TCP connection to diagnose whether Codex reaches the proxy
  server.on("connection", function (socket) {
    var addr = socket.remoteAddress || "?";
    log.info("TCP connection from " + addr);
  });

  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      status = "error";
      lastError = error.message;
      log.error("Server error: " + error.message);
      reject(error);
    });
    server.listen(port, host, () => {
      status = "running";
      lastError = "";
      log.info("Listening on http://" + host + ":" + port + "/v1");
      resolve(server);
    });
  });
}

function stopProxyServer() {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    const closing = server;
    server = null;

    // Force-close all connections so close callback fires promptly (Node 18+)
    if (typeof closing.closeAllConnections === "function") {
      closing.closeAllConnections();
    }

    const forceTimeout = setTimeout(() => {
      log.warn("Server close timed out, forcing destroy");
      try {
        closing.close();
      } catch {}
      status = "stopped";
      resolve();
    }, 3000);

    closing.close(() => {
      clearTimeout(forceTimeout);
      status = "stopped";
      log.info("Stopped.");
      resolve();
    });
  });
}

function getStatus() {
  return status;
}

function getLastError() {
  return lastError;
}

async function handleRequest(req, res, settings, providers) {
  // Raw log at earliest possible point — before any processing
  log.info("RAW " + req.method + " " + (req.url || "?") + " from " + (req.socket.remoteAddress || "?"));

  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const pathname = url.pathname;

  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  log.info("→ " + req.method + " " + pathname);

  try {
    if (pathname === "/v1/responses" && req.method === "POST") {
      await handleResponses(req, res, settings, providers);
    } else if (pathname === "/v1/responses/compact" && req.method === "POST") {
      await handleResponsesCompact(req, res, settings, providers);
    } else if (pathname === "/v1/responses/input_tokens" && req.method === "POST") {
      await handleInputTokens(req, res);
    } else if ((pathname === "/v1/models" || pathname === "/models") && req.method === "GET") {
      handleModels(req, res, providers);
    } else if (pathname === "/healthz" || pathname === "/v1/healthz") {
      sendJson(res, 200, { ok: true, service: "codex-bridge", status });
    } else {
      // /v1/responses/:id and /v1/responses/:id/input_items
      const responseMatch = pathname.match(/^\/v1\/responses\/([^/]+)$/);
      const inputItemsMatch = pathname.match(/^\/v1\/responses\/([^/]+)\/input_items$/);
      if (responseMatch && req.method === "GET") {
        handleGetResponse(req, res, responseMatch[1]);
      } else if (responseMatch && req.method === "DELETE") {
        handleDeleteResponse(req, res, responseMatch[1]);
      } else if (inputItemsMatch && req.method === "GET") {
        handleGetInputItems(req, res, inputItemsMatch[1]);
      } else {
        sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error", code: "not_found" } });
      }
    }
  } catch (error) {
    log.error("Request error: " + error.message);
    sendJson(res, 500, { error: { message: error.message || "Internal error", type: "server_error", code: "internal_error" } });
  }
}

async function handleResponses(req, res, settings, providers) {
  const body = await readBody(req);
  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch {
    sendJson(res, 400, {
      error: { message: "Invalid JSON in request body", type: "invalid_request_error", code: "invalid_json" },
    });
    return;
  }

  const result = getProviderByModel(providers, requestBody.model);
  if (!result) {
    if (settings.fallbackModel) {
      const fallback = getProviderByModel(providers, settings.fallbackModel);
      if (fallback) {
        log.warn("model " + (requestBody.model || "?") + " not found, falling back to " + settings.fallbackModel);
        requestBody.model = settings.fallbackModel;
        log.info(
          "→ POST /v1/responses stream=" +
            (requestBody.stream !== false) +
            " model=" +
            requestBody.model +
            " (fallback) → " +
            fallback.provider.name,
        );
        await orchestrate(req, res, requestBody, fallback.provider, fallback.modelConfig, settings);
        return;
      }
    }
    sendJson(res, 503, {
      error: { message: "No provider configured for model: " + (requestBody.model || "?"), type: "server_error", code: "no_provider" },
    });
    return;
  }

  log.info(
    "→ POST /v1/responses stream=" + (requestBody.stream !== false) + " model=" + (requestBody.model || "?") + " → " + result.provider.name,
  );
  await orchestrate(req, res, requestBody, result.provider, result.modelConfig, settings);
}

async function handleResponsesCompact(req, res, settings, providers) {
  const body = await readBody(req);
  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch {
    sendJson(res, 400, {
      error: { message: "Invalid JSON in request body", type: "invalid_request_error", code: "invalid_json" },
    });
    return;
  }

  const result2 = getProviderByModel(providers, requestBody.model);
  if (!result2) {
    if (settings.fallbackModel) {
      const fallback2 = getProviderByModel(providers, settings.fallbackModel);
      if (fallback2) {
        log.warn("model " + (requestBody.model || "?") + " not found (compact), falling back to " + settings.fallbackModel);
        requestBody.model = settings.fallbackModel;
        await orchestrate(req, res, requestBody, fallback2.provider, fallback2.modelConfig, settings);
        return;
      }
    }
    sendJson(res, 503, {
      error: { message: "No provider configured for model: " + (requestBody.model || "?"), type: "server_error", code: "no_provider" },
    });
    return;
  }

  await orchestrate(req, res, requestBody, result2.provider, result2.modelConfig, settings);
}

async function handleInputTokens(req, res) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, {
      error: { message: "Invalid JSON in request body", type: "invalid_request_error", code: "invalid_json" },
    });
    return;
  }

  // Simple heuristic: CJK chars ~= 2 tokens, others ~= 4 chars per token
  const text = extractInputText(payload);
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const other = text.length - cjk;
  const tokens = Math.max(1, Math.ceil(cjk / 1.5) + Math.ceil(other / 4));

  sendJson(res, 200, { input_tokens: tokens });
}

function extractInputText(payload) {
  const input = payload.input;
  if (!input) return "";
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input
    .map(function (item) {
      if (!item) return "";
      if (typeof item === "string") return item;
      const content = item.content;
      if (!content) return "";
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter(function (c) {
            return c && (c.type === "input_text" || c.type === "output_text" || c.type === "text");
          })
          .map(function (c) {
            return c.text || "";
          })
          .join(" ");
      }
      return "";
    })
    .join(" ");
}

function handleGetResponse(req, res, responseId) {
  const response = responseStore.get(responseId);
  if (!response) {
    sendJson(res, 404, { error: { message: "Response not found", type: "invalid_request_error", code: "not_found" } });
    return;
  }
  sendJson(res, 200, response);
}

function handleDeleteResponse(req, res, responseId) {
  const deleted = responseStore.remove(responseId);
  sendJson(res, 200, { id: responseId, object: "response.deleted", deleted: deleted });
}

function handleGetInputItems(req, res, responseId) {
  const items = responseStore.getInputItems(responseId);
  if (!items) {
    sendJson(res, 404, { error: { message: "Response not found", type: "invalid_request_error", code: "not_found" } });
    return;
  }
  sendJson(res, 200, { object: "list", data: items });
}

function handleModels(req, res, providers) {
  const models = [];
  (providers || []).forEach(function (p) {
    (p.models || []).forEach(function (m) {
      if (m.id && p.key) models.push(p.key + "/" + m.id);
    });
  });
  if (models.length === 0) models.push("provider/gpt-4o");
  sendJson(res, 200, {
    object: "list",
    data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "codex-bridge" })),
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
  updateSettings(newSettings) {
    if (activeSettings && newSettings) {
      Object.assign(activeSettings, newSettings);
    }
  },
  updateProviders(newProviders) {
    _activeProviders = newProviders;
  },
};
