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

function createMockOpenAIChatServer(mode) {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const data = JSON.parse(body);

        if (data.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          var chunks;
          if (mode === "reasoning_with_literal_think") {
            chunks = [
              { choices: [{ delta: { role: "assistant" }, index: 0 }] },
              { choices: [{ delta: { reasoning_content: "Let me think" }, index: 0 }] },
              { choices: [{ delta: { content: "The <thinking>" }, index: 0 }] },
              { choices: [{ delta: { content: " tag parser handles various tags." }, index: 0 }] },
              { choices: [{ delta: {}, index: 0, finish_reason: "stop" }] },
            ];
          } else {
            chunks = [
              { choices: [{ delta: { role: "assistant" }, index: 0 }] },
              { choices: [{ delta: { content: "Hello" }, index: 0 }] },
              { choices: [{ delta: { content: " world" }, index: 0 }] },
              {
                choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              },
            ];
          }
          for (const chunk of chunks) {
            res.write("data: " + JSON.stringify(chunk) + "\n\n");
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
          );
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
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function testHealthEndpoint() {
  console.log("\n[Test] Health endpoint");
  const res = await httpRequest({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/healthz", method: "GET" });
  const data = JSON.parse(res.body);
  assert(res.status === 200, "Status 200");
  assert(data.ok === true, "ok is true");
  assert(data.service === "codex-bridge", "service name correct");
}

async function testModelsEndpoint() {
  console.log("\n[Test] Models endpoint");
  const res = await httpRequest({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/models", method: "GET" });
  const data = JSON.parse(res.body);
  assert(res.status === 200, "Status 200");
  assert(data.object === "list", "object is list");
  assert(data.data.length === 1, "one model returned");
  assert(data.data[0].id === "test/gpt-4o", "model id is key/modelId format");
}

async function testResponsesSync() {
  console.log("\n[Test] Responses (sync, OpenAI Chat)");
  const body = JSON.stringify({
    model: "test/gpt-4o",
    input: "Say hello",
    stream: false,
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
  const data = JSON.parse(res.body);
  assert(res.status === 200, "Status 200");
  assert(data.object === "response", "object is response");
  assert(data.status === "completed", "status completed");
  assert(data.output.length > 0, "has output items");
  const msg = data.output.find((o) => o.type === "message");
  assert(msg !== undefined, "has message output");
  assert(msg.content[0].text === "Hello world", "text content matches");
  assert(data.usage.input_tokens === 10, "input tokens correct");
}

async function testResponsesStream() {
  console.log("\n[Test] Responses (stream, OpenAI Chat)");
  const body = JSON.stringify({
    model: "test/gpt-4o",
    input: "Say hello",
    stream: true,
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
  assert(res.status === 200, "Status 200");
  assert(res.headers["content-type"].includes("text/event-stream"), "Content-Type is SSE");

  const events = parseSSEEvents(res.body);
  const types = events.map((e) => e.type);
  assert(types.includes("response.created"), "has response.created");
  assert(types.includes("response.output_text.delta"), "has text delta");
  assert(types.includes("response.completed"), "has response.completed");

  const deltas = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta);
  assert(deltas.join("") === "Hello world", "streamed text matches");

  const completed = events.find((e) => e.type === "response.completed");
  assert(completed.response.status === "completed", "response status completed");
}

async function testNoProvider() {
  console.log("\n[Test] No provider returns 503");
  await stopProxyServer();
  await createProxyServer({ port: PROXY_PORT, host: "127.0.0.1" }, []);
  await delay(200);

  const body = JSON.stringify({ model: "test", input: "hi", stream: false });
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
  assert(res.status === 503, "Status 503 when no provider");
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

async function testThinkParserSkippedWithReasoningContent() {
  console.log("\n[Test] ThinkParser skipped with reasoning_content");

  mockServer.close();
  await delay(100);
  await createMockOpenAIChatServer("reasoning_with_literal_think");

  await stopProxyServer();
  await delay(100);

  var providers = [
    {
      name: "Test Provider TS",
      key: "ts",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:" + MOCK_PORT + "/v1",
      apiKey: "test-key",
      models: [{ id: "test-model", maxOutputK: 64, maxContextK: 128 }],
    },
  ];
  await createProxyServer({ port: PROXY_PORT, host: "127.0.0.1" }, providers);
  await delay(300);

  var body = JSON.stringify({
    model: "ts/test-model",
    input: "Say hello",
    stream: true,
  });
  var res = await httpRequest(
    {
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/v1/responses",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body,
  );
  assert(res.status === 200, "Status 200");

  var events = parseSSEEvents(res.body);
  var reasoningDeltas = events
    .filter(function (e) { return e.type === "response.reasoning_summary_text.delta"; })
    .map(function (e) { return e.delta; });
  assert(reasoningDeltas.join("").indexOf("Let me think") !== -1, "reasoning_content forwarded as reasoning delta");

  var textDeltas = events
    .filter(function (e) { return e.type === "response.output_text.delta"; })
    .map(function (e) { return e.delta; });
  var fullText = textDeltas.join("");
  assert(fullText.indexOf("<thinking>") !== -1, "literal <thinking> text preserved in output");
}

async function main() {
  console.log("=== Codex-Bridge Proxy Integration Tests ===");

  PROXY_PORT = await getAvailablePort();
  await createMockOpenAIChatServer();
  console.log("[Setup] Mock OpenAI Chat server on port " + MOCK_PORT);

  const providers = [
    {
      name: "Test Provider",
      key: "test",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:" + MOCK_PORT + "/v1",
      apiKey: "test-key",
      models: [{ id: "gpt-4o", maxOutputK: 64, maxContextK: 128 }],
    },
  ];

  await createProxyServer({ port: PROXY_PORT, host: "127.0.0.1" }, providers);
  await delay(300);
  console.log("[Setup] Proxy server on port " + PROXY_PORT);

  try {
    await testHealthEndpoint();
    await testModelsEndpoint();
    await testResponsesSync();
    await testResponsesStream();
    await testThinkParserSkippedWithReasoningContent();
    await testNoProvider();
  } catch (err) {
    console.error("\n[ERROR] Unexpected:", err);
    failed++;
  }

  await stopProxyServer();
  mockServer.close();
  await delay(100);

  console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

main();
