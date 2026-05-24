"use strict";

const http = require("node:http");
const { createProxyServer, stopProxyServer } = require("../src/proxy/server");

let PROXY_PORT = 0;
let MOCK_PORT = 0;

let mockServer = null;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log("  PASS: " + message);
  } else {
    failed++;
    console.error("  FAIL: " + message);
  }
}

function getAvailablePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function createMockErrorServer(mode, options) {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let _body = "";
      req.on("data", (chunk) => {
        _body += chunk;
      });
      req.on("end", () => {
        if (mode === "status") {
          res.writeHead(options.statusCode || 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: options.message || "Mock error" } }));
        } else if (mode === "stream-abort") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "partial" }, index: 0 }] }) + "\n\n");
          // Close without [DONE] to simulate interruption
          res.socket.destroy();
        } else if (mode === "stream-error") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "partial" }, index: 0 }] }) + "\n\n");
          res.write("data: " + JSON.stringify({ error: { message: "Upstream error" } }) + "\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
        } else if (mode === "corrupt-sse") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, index: 0 }] }) + "\n\n");
          res.write("data: this is not json\n\n");
          res.write("data: " + JSON.stringify({ choices: [{ delta: { content: " more" }, index: 0, finish_reason: "stop" }] }) + "\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
        } else if (mode === "stream-tool-calls") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const chunks = [
            {
              choices: [
                { delta: { tool_calls: [{ index: 0, id: "call_01", function: { name: "get_weather", arguments: "" } }] }, index: 0 },
              ],
            },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Beijing"}' } }] }, index: 0 }] },
            { choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }] },
          ];
          for (const chunk of chunks) {
            res.write("data: " + JSON.stringify(chunk) + "\n\n");
          }
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      MOCK_PORT = mockServer.address().port;
      resolve();
    });
  });
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", (err) => {
      if (options._captureError) {
        resolve({ status: 0, headers: {}, body: "", error: err.message });
      } else {
        reject(err);
      }
    });
    if (body) req.write(body);
    req.end();
  });
}

function parseSSEEvents(raw) {
  const events = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        events.push(JSON.parse(payload));
      } catch {}
    }
  }
  return events;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- OpenAI Chat error path tests ---

async function testSyncUpstream400() {
  console.log("\n[Test] Sync upstream 400 proxies status code");
  await stopMockAndCreate("status", { statusCode: 400, message: "Bad request from upstream" });

  const body = JSON.stringify({ model: "test/gpt-4o", input: "hi", stream: false });
  const res = await httpRequest(
    {
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/v1/responses",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body,
  );
  assert(res.status === 400, "Status 400 proxied (not 502)");
  const data = JSON.parse(res.body);
  assert(data.error !== undefined, "error object present");
  assert(data.error.type === "api_error", "error type is api_error");
}

async function testSyncUpstream500() {
  console.log("\n[Test] Sync upstream 500 proxies status code");
  await stopMockAndCreate("status", { statusCode: 500, message: "Internal server error" });

  const body = JSON.stringify({ model: "test/gpt-4o", input: "hi", stream: false });
  const res = await httpRequest(
    {
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/v1/responses",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body,
  );
  assert(res.status === 500, "Status 500 proxied (not 502)");
}

async function testSyncUpstream401() {
  console.log("\n[Test] Sync upstream 401 proxies status code");
  await stopMockAndCreate("status", { statusCode: 401, message: "Unauthorized" });

  const body = JSON.stringify({ model: "test/gpt-4o", input: "hi", stream: false });
  const res = await httpRequest(
    {
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/v1/responses",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body,
  );
  assert(res.status === 401, "Status 401 proxied (not 502)");
}

async function testStreamInterruption() {
  console.log("\n[Test] Stream interruption emits error");
  await stopMockAndCreate("stream-abort", {});

  const body = JSON.stringify({ model: "test/gpt-4o", input: "hi", stream: true });
  const res = await httpRequest(
    {
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/v1/responses",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body,
  );

  // The response should still be SSE but end with a failed event
  const events = parseSSEEvents(res.body);
  const types = events.map((e) => e.type);
  assert(types.includes("response.created"), "has response.created");
  // Should have a failed event (not completed) due to stream interruption
  const hasFailed = types.includes("response.failed");
  const hasCompleted = types.includes("response.completed");
  assert(hasFailed || !hasCompleted, "does not emit false completed on interruption");
}

async function testCorruptSseChunks() {
  console.log("\n[Test] Corrupt SSE chunks handled gracefully");
  await stopMockAndCreate("corrupt-sse", {});

  const body = JSON.stringify({ model: "test/gpt-4o", input: "hi", stream: true });
  const res = await httpRequest(
    {
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/v1/responses",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body,
  );

  const events = parseSSEEvents(res.body);
  const deltas = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta);
  // Only valid JSON chunks produce text deltas; corrupt line is skipped
  assert(deltas.includes("ok"), "valid chunk before corrupt line processed");
  assert(deltas.includes(" more"), "valid chunk after corrupt line processed");
  assert(deltas.join("") === "ok more", "corrupt line skipped without breaking stream");
}

async function testOpenAIToolCalls() {
  console.log("\n[Test] OpenAI Chat streaming tool calls");
  await stopMockAndCreate("stream-tool-calls", {});

  const body = JSON.stringify({
    model: "test/gpt-4o",
    input: "What's the weather?",
    stream: true,
    tools: [{ type: "function", name: "get_weather", description: "Get weather", parameters: {} }],
  });
  const res = await httpRequest(
    {
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/v1/responses",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body,
  );

  const events = parseSSEEvents(res.body);
  const types = events.map((e) => e.type);
  assert(types.includes("response.function_call_arguments.delta"), "has function_call_arguments.delta");
  assert(types.includes("response.function_call_arguments.done"), "has function_call_arguments.done");
  assert(types.includes("response.completed"), "has completed event");

  const fcDone = events.find((e) => e.type === "response.function_call_arguments.done");
  assert(fcDone !== undefined, "tool call completed");
  const args = JSON.parse(fcDone.arguments);
  assert(args.city === "Beijing", "tool arguments correct");
}

// --- Anthropic error path tests ---

async function testAnthropicSyncError() {
  console.log("\n[Test] Anthropic sync upstream error");
  await stopMockAndCreate("status", { statusCode: 429, message: "Rate limited" });

  const providers = [
    {
      name: "Error Anth",
      key: "anth",
      protocol: "anthropic",
      baseUrl: "http://127.0.0.1:" + MOCK_PORT,
      apiKey: "tk",
      models: [{ id: "claude-sonnet-4-20250514", maxOutputK: 64, maxContextK: 128 }],
    },
  ];
  await stopProxyServer();
  await createProxyServer({ port: PROXY_PORT, host: "127.0.0.1" }, providers);
  await delay(200);

  const body = JSON.stringify({ model: "anth/claude-sonnet-4-20250514", input: "hi", stream: false });
  const res = await httpRequest(
    {
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/v1/responses",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body,
  );
  assert(res.status === 429, "Status 429 proxied");
}

async function testAnthropicStreamInterruption() {
  console.log("\n[Test] Anthropic stream interruption emits error");
  await stopMockAndCreate("stream-abort", {});

  const providers = [
    {
      name: "StreamErr Anth",
      key: "anth",
      protocol: "anthropic",
      baseUrl: "http://127.0.0.1:" + MOCK_PORT,
      apiKey: "tk",
      models: [{ id: "claude-sonnet-4-20250514", maxOutputK: 64, maxContextK: 128 }],
    },
  ];
  await stopProxyServer();
  await createProxyServer({ port: PROXY_PORT, host: "127.0.0.1" }, providers);
  await delay(200);

  const body = JSON.stringify({ model: "anth/claude-sonnet-4-20250514", input: "hi", stream: true });
  const res = await httpRequest(
    {
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/v1/responses",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body,
  );

  const events = parseSSEEvents(res.body);
  const types = events.map((e) => e.type);
  const hasFailed = types.includes("response.failed");
  const hasCompleted = types.includes("response.completed");
  assert(hasFailed || !hasCompleted, "no false completed on stream interruption");
}

async function stopMockAndCreate(mode, options) {
  if (mockServer) mockServer.close();
  await delay(100);
  await createMockErrorServer(mode, options);
  // Restart proxy with updated mock port (default openai-chat; Anthropic tests override below)
  await stopProxyServer();
  const providers = [
    {
      name: "Error Test",
      key: "test",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:" + MOCK_PORT + "/v1",
      apiKey: "tk",
      models: [{ id: "gpt-4o", maxOutputK: 64, maxContextK: 128 }],
    },
  ];
  await createProxyServer({ port: PROXY_PORT, host: "127.0.0.1" }, providers);
  await delay(100);
}

async function main() {
  console.log("=== Codex-Bridge Error Path Tests ===");

  PROXY_PORT = await getAvailablePort();
  await createMockErrorServer("status", { statusCode: 200, message: "ok" });
  console.log("[Setup] Mock error server on port " + MOCK_PORT);
  const providers = [
    {
      name: "Error Test",
      key: "test",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:" + MOCK_PORT + "/v1",
      apiKey: "tk",
      models: [{ id: "gpt-4o", maxOutputK: 64, maxContextK: 128 }],
    },
  ];
  await createProxyServer({ port: PROXY_PORT, host: "127.0.0.1" }, providers);
  await delay(300);
  console.log("[Setup] Proxy server on port " + PROXY_PORT);

  try {
    await testSyncUpstream400();
    await testSyncUpstream500();
    await testSyncUpstream401();
    await testStreamInterruption();
    await testCorruptSseChunks();
    await testOpenAIToolCalls();
    await testAnthropicSyncError();
    await testAnthropicStreamInterruption();
  } catch (err) {
    console.error("\n[ERROR] Unexpected:", err);
    failed++;
  }

  await stopProxyServer();
  if (mockServer) mockServer.close();
  await delay(100);

  console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

main();
