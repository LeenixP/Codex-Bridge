"use strict";

const http = require("node:http");
const { createProxyServer, stopProxyServer } = require("../src/proxy/server");

const PROXY_PORT = 19789;
const MOCK_PORT = 19790;

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

function createMockAnthropicServer() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let _body = "";
      req.on("data", (chunk) => { _body += chunk; });
      req.on("end", () => {
        const data = JSON.parse(_body);

        if (data.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const events = [
            { type: "message_start", message: { id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-4-20250514", usage: { input_tokens: 25, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " about this." } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
            { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " from Claude" } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
            { type: "message_stop" },
          ];
          for (const event of events) {
            res.write("event: " + event.type + "\n");
            res.write("data: " + JSON.stringify(event) + "\n\n");
          }
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "msg_01",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [
              { type: "thinking", thinking: "Let me think about this." },
              { type: "text", text: "Hello from Claude" },
            ],
            usage: { input_tokens: 25, output_tokens: 12 },
          }));
        }
      });
    });
    mockServer.listen(MOCK_PORT, "127.0.0.1", () => resolve());
  });
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
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
      try { events.push(JSON.parse(payload)); } catch {}
    }
  }
  return events;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testAnthropicSync() {
  console.log("\n[Test] Responses (sync, Anthropic)");
  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    input: "Say hello",
    instructions: "You are helpful.",
    stream: false,
    reasoning: { effort: "medium" },
  });
  const res = await httpRequest({
    hostname: "127.0.0.1",
    port: PROXY_PORT,
    path: "/v1/responses",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, body);
  const data = JSON.parse(res.body);
  assert(res.status === 200, "Status 200");
  assert(data.status === "completed", "status completed");
  const reasoning = data.output.find((o) => o.type === "reasoning");
  assert(reasoning !== undefined, "has reasoning output");
  assert(reasoning.summary[0].text.includes("think"), "reasoning text present");
  const msg = data.output.find((o) => o.type === "message");
  assert(msg !== undefined, "has message output");
  assert(msg.content[0].text === "Hello from Claude", "text content matches");
  assert(data.usage.input_tokens === 25, "input tokens correct");
  assert(data.usage.output_tokens === 12, "output tokens correct");
}

async function testAnthropicStream() {
  console.log("\n[Test] Responses (stream, Anthropic with thinking)");
  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    input: "Say hello",
    instructions: "You are helpful.",
    stream: true,
    reasoning: { effort: "high" },
  });
  const res = await httpRequest({
    hostname: "127.0.0.1",
    port: PROXY_PORT,
    path: "/v1/responses",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, body);
  assert(res.status === 200, "Status 200");
  assert(res.headers["content-type"].includes("text/event-stream"), "Content-Type is SSE");

  const events = parseSSEEvents(res.body);
  const types = events.map((e) => e.type);

  assert(types.includes("response.created"), "has response.created");
  assert(types.includes("response.reasoning_summary_text.delta"), "has reasoning delta");
  assert(types.includes("response.reasoning_summary_text.done"), "has reasoning done");
  assert(types.includes("response.output_text.delta"), "has text delta");
  assert(types.includes("response.completed"), "has response.completed");

  const reasoningDeltas = events
    .filter((e) => e.type === "response.reasoning_summary_text.delta")
    .map((e) => e.delta);
  assert(reasoningDeltas.join("") === "Let me think about this.", "reasoning text matches");

  const textDeltas = events
    .filter((e) => e.type === "response.output_text.delta")
    .map((e) => e.delta);
  assert(textDeltas.join("") === "Hello from Claude", "streamed text matches");

  const completed = events.find((e) => e.type === "response.completed");
  assert(completed.response.status === "completed", "response status completed");
  assert(completed.response.output.length === 2, "output has 2 items (reasoning + message)");
}

async function testAnthropicToolUse() {
  console.log("\n[Test] Responses (sync, Anthropic tool_use)");

  // Replace mock to return tool_use
  mockServer.close();
  await delay(100);
  await new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let _body = "";
      req.on("data", (chunk) => { _body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_02",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-20250514",
          content: [
            { type: "text", text: "I'll search for that." },
            { type: "tool_use", id: "toolu_01", name: "web_search", input: { query: "hello world" } },
          ],
          usage: { input_tokens: 30, output_tokens: 20 },
        }));
      });
    });
    mockServer.listen(MOCK_PORT, "127.0.0.1", () => resolve());
  });

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    input: "Search for hello world",
    stream: false,
    tools: [{ type: "function", name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string" } } } }],
  });
  const res = await httpRequest({
    hostname: "127.0.0.1",
    port: PROXY_PORT,
    path: "/v1/responses",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, body);
  const data = JSON.parse(res.body);
  assert(res.status === 200, "Status 200");
  assert(data.status === "completed", "status completed");
  const msg = data.output.find((o) => o.type === "message");
  assert(msg !== undefined, "has message output");
  const fc = data.output.find((o) => o.type === "function_call");
  assert(fc !== undefined, "has function_call output");
  assert(fc.name === "web_search", "tool name matches");
  const args = JSON.parse(fc.arguments);
  assert(args.query === "hello world", "tool arguments correct");
}

async function main() {
  console.log("=== Codex-Switch Anthropic Integration Tests ===");

  await createMockAnthropicServer();
  console.log("[Setup] Mock Anthropic server on port " + MOCK_PORT);

  const providers = [{
    name: "Test Anthropic",
    protocol: "anthropic",
    baseUrl: "http://127.0.0.1:" + MOCK_PORT,
    apiKey: "test-key",
    model: "claude-sonnet-4-20250514",
    active: true,
  }];

  createProxyServer({ port: PROXY_PORT, host: "127.0.0.1" }, providers);
  await delay(300);
  console.log("[Setup] Proxy server on port " + PROXY_PORT);

  try {
    await testAnthropicSync();
    await testAnthropicStream();
    await testAnthropicToolUse();
  } catch (err) {
    console.error("\n[ERROR] Unexpected:", err);
    failed++;
  }

  stopProxyServer();
  mockServer.close();
  await delay(100);

  console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

main();
