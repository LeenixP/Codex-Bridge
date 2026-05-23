"use strict";

const openai = require("../src/proxy/adapters/openai-chat");
const anthropic = require("../src/proxy/adapters/anthropic");
const { createSseBridge } = require("../src/proxy/core/sse-bridge");
const events = require("../src/proxy/core/events");
const reasoningCache = require("../src/proxy/core/reasoning-cache");
const { makeId, createSequence, emitSse } = require("../src/shared/http");
const { parseSSEStream } = require("../src/shared/stream");
const presets = require("../src/proxy/presets/index");

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an async iterable from string/Buffer chunks for parseSSEStream tests. */
function makeAsyncIterable(chunks) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { done: true };
        },
      };
    },
  };
}

/** Create a mock HTTP response object that captures writes. */
function makeMockResponse() {
  const res = {
    written: [],
    ended: false,
    writableEnded: false,
    _head: null,
    writeHead(code, headers) {
      this._head = { code, headers };
    },
    write(data) {
      this.written.push(data);
    },
    end() {
      this.ended = true;
      this.writableEnded = true;
    },
    socket: { setNoDelay() {} },
    flushHeaders() {},
  };
  return res;
}

/** Parse captured SSE writes into { event, data } objects. */
function parseSseResponse(res) {
  const full = res.written.join("");
  const messages = [];
  for (const block of full.split("\n\n")) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    let ev = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) ev = line.slice(7);
      if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (ev && data) {
      try {
        messages.push({ event: ev, data: JSON.parse(data) });
      } catch {
        /* skip */
      }
    }
  }
  return messages;
}

// ===========================================================================
// 1. OpenAI Chat Adapter tests
// ===========================================================================

function testOpenAIChatStringInput() {
  console.log("\n[Test] openai-chat: string input -> single user message");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: "Hello world" }, { model: "gpt-4o" }, {});
  assert(payload.messages.length === 1, "one message");
  assert(payload.messages[0].role === "user", "role is user");
  assert(payload.messages[0].content === "Hello world", "content matches");
}

function testOpenAIChatArrayInputRoleBased() {
  console.log("\n[Test] openai-chat: array input with role-based items");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Follow up" },
      ],
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.messages.length === 3, "three messages");
  assert(payload.messages[0].role === "user", "first role is user");
  assert(payload.messages[0].content === "First question", "first content matches");
  assert(payload.messages[1].role === "assistant", "second role is assistant");
  assert(payload.messages[1].content === "First answer", "second content matches");
  assert(payload.messages[2].role === "user", "third role is user");
}

function testOpenAIChatArrayInputMessageType() {
  console.log("\n[Test] openai-chat: array input with message-type items");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: "Hello from message type" }],
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.messages.length === 1, "one message");
  assert(payload.messages[0].role === "user", "role is user");
  assert(payload.messages[0].content === "Hello from message type", "content matches");
}

function testOpenAIChatInstructions() {
  console.log("\n[Test] openai-chat: instructions -> system message");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: "Hello",
      instructions: "You are a helpful assistant.",
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.messages.length === 2, "two messages (system + user)");
  assert(payload.messages[0].role === "system", "first message is system");
  assert(payload.messages[0].content === "You are a helpful assistant.", "system content matches");
  assert(payload.messages[1].role === "user", "second message is user");
}

function testOpenAIChatMaxOutputTokens() {
  console.log("\n[Test] openai-chat: max_output_tokens -> max_completion_tokens");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: "Hi", max_output_tokens: 4096 }, { model: "gpt-4o" }, {});
  assert(payload.max_completion_tokens === 4096, "max_completion_tokens set");
}

function testOpenAIChatTemperatureTopP() {
  console.log("\n[Test] openai-chat: temperature and top_p passthrough");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: "Hi", temperature: 0.7, top_p: 0.9 }, { model: "gpt-4o" }, {});
  assert(payload.temperature === 0.7, "temperature passthrough");
  assert(payload.top_p === 0.9, "top_p passthrough");
}

function testOpenAIChatTemperatureZero() {
  console.log("\n[Test] openai-chat: temperature=0 passes through");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: "Hi", temperature: 0 }, { model: "gpt-4o" }, {});
  assert(payload.temperature === 0, "temperature=0 preserved (not skipped)");
}

function testOpenAIChatReasoningEffort() {
  console.log("\n[Test] openai-chat: reasoning.effort -> reasoning_effort");
  const payload = openai.buildUpstreamRequest({ model: "o1", input: "Solve this", reasoning: { effort: "high" } }, { model: "o1" }, {});
  assert(payload.reasoning_effort === "high", "reasoning_effort set");
}

function testOpenAIChatJsonObjectFormat() {
  console.log("\n[Test] openai-chat: text.format json_object -> response_format");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: "Return JSON",
      text: { format: { type: "json_object" } },
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.response_format !== undefined, "has response_format");
  assert(payload.response_format.type === "json_object", "type is json_object");
}

function testOpenAIChatJsonSchemaFormat() {
  console.log("\n[Test] openai-chat: text.format json_schema -> response_format");
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: "Return JSON",
      text: { format: { type: "json_schema", name: "person", strict: true, schema } },
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.response_format.type === "json_schema", "type is json_schema");
  assert(payload.response_format.json_schema.name === "person", "name preserved");
  assert(payload.response_format.json_schema.strict === true, "strict preserved");
  assert(payload.response_format.json_schema.schema.properties.name.type === "string", "schema preserved");
}

function testOpenAIChatTools() {
  console.log("\n[Test] openai-chat: tools with function type -> tools array");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: "Weather?",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    },
    { model: "gpt-4o" },
    {},
  );
  assert(Array.isArray(payload.tools) && payload.tools.length === 1, "has one tool");
  assert(payload.tools[0].type === "function", "tool type is function");
  assert(payload.tools[0].function.name === "get_weather", "function name matches");
  assert(payload.tools[0].function.description === "Get weather", "function description matches");
  assert(payload.tools[0].function.parameters.properties.city.type === "string", "parameters preserved");
}

function testOpenAIChatToolsFiltersNonFunction() {
  console.log("\n[Test] openai-chat: tools filters non-function types");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: "Hi",
      tools: [
        { type: "function", name: "valid" },
        { type: "web_search", name: "search" },
      ],
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.tools.length === 1, "only function tools kept");
  assert(payload.tools[0].function.name === "valid", "correct tool kept");
}

function testOpenAIChatFunctionCallInput() {
  console.log("\n[Test] openai-chat: function_call input item -> assistant with tool_calls");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [{ type: "function_call", call_id: "call_abc", name: "get_weather", arguments: '{"city":"NYC"}' }],
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.messages.length === 1, "one message");
  const msg = payload.messages[0];
  assert(msg.role === "assistant", "role is assistant");
  assert(Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1, "has tool_calls array");
  assert(msg.tool_calls[0].id === "call_abc", "call_id preserved");
  assert(msg.tool_calls[0].type === "function", "type is function");
  assert(msg.tool_calls[0].function.name === "get_weather", "function name preserved");
  assert(msg.tool_calls[0].function.arguments === '{"city":"NYC"}', "arguments preserved");
}

function testOpenAIChatFunctionCallOutputInput() {
  console.log("\n[Test] openai-chat: function_call_output input item -> tool message");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [{ type: "function_call_output", call_id: "call_abc", output: "Sunny, 72F" }],
    },
    { model: "gpt-4o" },
    {},
  );
  const msg = payload.messages[0];
  assert(msg.role === "tool", "role is tool");
  assert(msg.tool_call_id === "call_abc", "tool_call_id matches");
  assert(msg.content === "Sunny, 72F", "content matches");
}

function testOpenAIChatFunctionCallOutputObject() {
  console.log("\n[Test] openai-chat: function_call_output with object output -> stringified");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [{ type: "function_call_output", call_id: "call_abc", output: { temp: 72, condition: "sunny" } }],
    },
    { model: "gpt-4o" },
    {},
  );
  const msg = payload.messages[0];
  assert(msg.role === "tool", "role is tool");
  assert(typeof msg.content === "string", "content is stringified");
  const parsed = JSON.parse(msg.content);
  assert(parsed.temp === 72, "object content preserved via JSON");
}

function testOpenAIChatImageUrlNonBase64() {
  console.log("\n[Test] openai-chat: input_image with URL -> image_url part");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "What's this?" },
            { type: "input_image", image_url: "https://example.com/photo.jpg" },
          ],
        },
      ],
    },
    { model: "gpt-4o" },
    {},
  );
  const lastMsg = payload.messages[payload.messages.length - 1];
  assert(Array.isArray(lastMsg.content), "content is array");
  const imgPart = lastMsg.content.find(function (p) {
    return p.type === "image_url";
  });
  assert(imgPart !== undefined, "has image_url part");
  assert(imgPart.image_url.url === "https://example.com/photo.jpg", "URL preserved");
}

function testOpenAIChatImageUrlBase64() {
  console.log("\n[Test] openai-chat: input_image with base64 data URI");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe" },
            { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
          ],
        },
      ],
    },
    { model: "gpt-4o" },
    {},
  );
  const lastMsg = payload.messages[payload.messages.length - 1];
  const imgPart = lastMsg.content.find(function (p) {
    return p.type === "image_url";
  });
  assert(imgPart !== undefined, "has image_url part for base64");
  assert(imgPart.image_url.url.startsWith("data:image/png;base64,"), "base64 URI preserved");
}

function testOpenAIChatSingleTextPartFlat() {
  console.log("\n[Test] openai-chat: single text part -> string content (not array)");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
    },
    { model: "gpt-4o" },
    {},
  );
  const lastMsg = payload.messages[payload.messages.length - 1];
  assert(typeof lastMsg.content === "string", "content is string (not array)");
  assert(lastMsg.content === "Hello", "text matches");
}

function testOpenAIChatEmptyInput() {
  console.log("\n[Test] openai-chat: empty input -> empty messages array");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: "" }, { model: "gpt-4o" }, {});
  assert(payload.messages.length === 0, "no messages for empty string input");
}

function testOpenAIChatEmptyInputArray() {
  console.log("\n[Test] openai-chat: empty input array -> empty messages");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: [] }, { model: "gpt-4o" }, {});
  assert(payload.messages.length === 0, "no messages for empty array input");
}

function testOpenAIChatVisionFalse() {
  console.log("\n[Test] openai-chat: vision=false provider -> image skipped");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Hi" },
            { type: "input_image", image_url: "https://example.com/photo.jpg" },
          ],
        },
      ],
    },
    { model: "gpt-4o", vision: false },
    {},
  );
  const lastMsg = payload.messages[payload.messages.length - 1];
  assert(typeof lastMsg.content === "string", "content flattens to string (no image)");
  assert(lastMsg.content === "Hi", "only text remains");
}

function testOpenAIChatMissingOptionalFields() {
  console.log("\n[Test] openai-chat: missing optional fields produce clean payload");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: "Hi" }, { model: "gpt-4o" }, {});
  assert(payload.model === "gpt-4o", "model set");
  assert(payload.stream === true, "stream defaults to true");
  assert(payload.temperature === undefined, "no temperature when absent");
  assert(payload.top_p === undefined, "no top_p when absent");
  assert(payload.max_completion_tokens === undefined, "no max_completion_tokens when absent");
  assert(payload.reasoning_effort === undefined, "no reasoning_effort when absent");
  assert(payload.response_format === undefined, "no response_format when absent");
  assert(payload.tools === undefined, "no tools when absent");
}

function testOpenAIChatStreamExplicitFalse() {
  console.log("\n[Test] openai-chat: stream:false respected");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: "Hi", stream: false }, { model: "gpt-4o" }, {});
  assert(payload.stream === false, "stream is false");
}

function testOpenAIChatProviderModelOverride() {
  console.log("\n[Test] openai-chat: provider.model overrides requestBody.model");
  const payload = openai.buildUpstreamRequest({ model: "override-me", input: "Hi" }, { model: "gpt-4o" }, {});
  assert(payload.model === "gpt-4o", "provider model used");
}

function testOpenAIChatStringInArray() {
  console.log("\n[Test] openai-chat: plain string inside input array");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: ["Hello", "World"] }, { model: "gpt-4o" }, {});
  assert(payload.messages.length === 2, "two messages");
  assert(payload.messages[0].content === "Hello", "first string");
  assert(payload.messages[1].content === "World", "second string");
}

// ===========================================================================
// 2. Anthropic Adapter tests
// ===========================================================================

function testAnthropicInstructions() {
  console.log("\n[Test] anthropic: instructions -> system field");
  const req = anthropic.buildUpstreamRequest(
    { model: "claude-sonnet-4-20250514", input: "Hello", instructions: "Be helpful." },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.system === "Be helpful.", "system matches instructions");
  assert(req.messages.length === 1, "one user message");
  assert(req.messages[0].role === "user", "user message role");
}

function testAnthropicSystemRoleInput() {
  console.log("\n[Test] anthropic: system-role in input -> system field");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [
        { role: "system", content: "Speak French." },
        { role: "user", content: "Bonjour" },
      ],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.system === "Speak French.", "system extracted from input");
  assert(req.messages.length === 1, "only user message in messages");
  assert(req.messages[0].role === "user", "user message preserved");
}

function testAnthropicSystemMerged() {
  console.log("\n[Test] anthropic: instructions + system-role merged with double newline");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [
        { role: "system", content: "Speak French." },
        { role: "user", content: "Bonjour" },
      ],
      instructions: "Be polite.",
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.system.indexOf("Be polite.") !== -1, "system contains instructions");
  assert(req.system.indexOf("Speak French.") !== -1, "system contains input system message");
  assert(req.system.indexOf("\n\n") !== -1, "system parts joined by double newline");
  assert(req.messages.length === 1, "one user message");
}

function testAnthropicReasoningLow() {
  console.log("\n[Test] anthropic: reasoning.effort=low -> budget_tokens=2000");
  const req = anthropic.buildUpstreamRequest(
    { model: "claude-sonnet-4-20250514", input: "Hi", reasoning: { effort: "low" } },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking.budget_tokens === 2000, "low = 2000");
  assert(req.thinking.type === "enabled", "thinking enabled");
  assert(req._betas.indexOf("thinking-2025") !== -1, "thinking beta flag set");
}

function testAnthropicReasoningMedium() {
  console.log("\n[Test] anthropic: reasoning.effort=medium -> budget_tokens=8000");
  const req = anthropic.buildUpstreamRequest(
    { model: "claude-sonnet-4-20250514", input: "Hi", reasoning: { effort: "medium" } },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking.budget_tokens === 8000, "medium = 8000");
}

function testAnthropicReasoningHigh() {
  console.log("\n[Test] anthropic: reasoning.effort=high -> budget_tokens=16000");
  const req = anthropic.buildUpstreamRequest(
    { model: "claude-sonnet-4-20250514", input: "Hi", reasoning: { effort: "high" } },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking.budget_tokens === 16000, "high = 16000");
}

function testAnthropicReasoningXhigh() {
  console.log("\n[Test] anthropic: reasoning.effort=xhigh -> min(max_tokens-1, 32000)");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: "Hi",
      max_output_tokens: 8192,
      reasoning: { effort: "xhigh" },
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking.budget_tokens === 8191, "xhigh = max_tokens - 1 when max_tokens < 32000");
}

function testAnthropicReasoningXhighLargeTokens() {
  console.log("\n[Test] anthropic: xhigh capped at 32000 for large max_tokens");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: "Hi",
      max_output_tokens: 100000,
      reasoning: { effort: "xhigh" },
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking.budget_tokens === 32000, "xhigh capped at 32000");
}

function testAnthropicReasoningMax() {
  console.log("\n[Test] anthropic: reasoning.effort=max -> same as xhigh");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: "Hi",
      max_output_tokens: 8192,
      reasoning: { effort: "max" },
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking.budget_tokens === 8191, "max = max_tokens - 1 (same as xhigh)");
  assert(req.thinking.type === "enabled", "thinking enabled for max");
}

function testAnthropicNoReasoning() {
  console.log("\n[Test] anthropic: no reasoning -> no thinking block");
  const req = anthropic.buildUpstreamRequest({ model: "claude-sonnet-4-20250514", input: "Hi" }, { model: "claude-sonnet-4-20250514" }, {});
  assert(req.thinking === undefined, "no thinking block");
}

function testAnthropicTools() {
  console.log("\n[Test] anthropic: tools -> Anthropic tool format with input_schema");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: "Weather?",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(Array.isArray(req.tools) && req.tools.length === 1, "has one tool");
  assert(req.tools[0].name === "get_weather", "tool name matches");
  assert(req.tools[0].description === "Get weather", "description matches");
  assert(req.tools[0].input_schema.required[0] === "city", "input_schema preserved");
}

function testAnthropicFunctionCall() {
  console.log("\n[Test] anthropic: function_call -> assistant tool_use content block");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [{ type: "function_call", call_id: "call_123", name: "get_weather", arguments: '{"city":"London"}' }],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  const asst = req.messages.find(function (m) {
    return m.role === "assistant";
  });
  assert(asst !== undefined, "has assistant message");
  assert(Array.isArray(asst.content), "content is array");
  assert(asst.content[0].type === "tool_use", "block type is tool_use");
  assert(asst.content[0].id === "call_123", "id preserved");
  assert(asst.content[0].name === "get_weather", "name preserved");
  assert(asst.content[0].input.city === "London", "arguments parsed");
}

function testAnthropicFunctionCallOutput() {
  console.log("\n[Test] anthropic: function_call_output -> user tool_result content block");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [{ type: "function_call_output", call_id: "call_123", output: "sunny" }],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  const userMsg = req.messages.find(function (m) {
    return m.role === "user";
  });
  assert(userMsg !== undefined, "has user message");
  assert(Array.isArray(userMsg.content), "content is array");
  const result = userMsg.content[0];
  assert(result.type === "tool_result", "block type is tool_result");
  assert(result.tool_use_id === "call_123", "tool_use_id preserved");
  assert(result.content === "sunny", "content preserved");
}

function testAnthropicFunctionCallMerge() {
  console.log("\n[Test] anthropic: function_call merges into preceding assistant message");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [
        { role: "assistant", content: "Let me check the weather." },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
      ],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  const asst = req.messages.find(function (m) {
    return m.role === "assistant";
  });
  assert(asst !== undefined, "has assistant message");
  assert(Array.isArray(asst.content), "content is array after merge");
  assert(asst.content.length >= 2, "has at least 2 blocks (text + tool_use)");
  assert(asst.content[0].type === "text", "first block is text");
  assert(asst.content[0].text === "Let me check the weather.", "text preserved");
  assert(asst.content[1].type === "tool_use", "second block is tool_use");
}

function testAnthropicFunctionCallOutputMerge() {
  console.log("\n[Test] anthropic: function_call_output merges into preceding user message");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [
        { role: "user", content: "What's the weather?" },
        { type: "function_call_output", call_id: "call_1", output: "72F sunny" },
      ],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  const userMsg = req.messages.find(function (m) {
    return m.role === "user";
  });
  assert(userMsg !== undefined, "has user message");
  assert(Array.isArray(userMsg.content), "content is array after merge");
  assert(userMsg.content.length >= 2, "has text + tool_result");
  assert(userMsg.content[0].type === "text", "first is text");
  assert(userMsg.content[1].type === "tool_result", "second is tool_result");
  assert(userMsg.content[1].content === "72F sunny", "tool result content preserved");
}

function testAnthropicImageDataUri() {
  console.log("\n[Test] anthropic: input_image with data: URI -> base64 image source");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe" },
            { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQ=" },
          ],
        },
      ],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  const lastMsg = req.messages[req.messages.length - 1];
  assert(Array.isArray(lastMsg.content), "content is array");
  const imgPart = lastMsg.content.find(function (p) {
    return p.type === "image";
  });
  assert(imgPart !== undefined, "has image part");
  assert(imgPart.source.type === "base64", "source type is base64");
  assert(imgPart.source.media_type === "image/jpeg", "media_type extracted");
  assert(imgPart.source.data === "/9j/4AAQ=", "base64 data extracted");
}

function testAnthropicImageHttpUrl() {
  console.log("\n[Test] anthropic: input_image with http URL -> skipped");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Hi" },
            { type: "input_image", image_url: "https://example.com/photo.jpg" },
          ],
        },
      ],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  const lastMsg = req.messages[req.messages.length - 1];
  assert(typeof lastMsg.content === "string", "non-data URI skipped, flattens to string");
  assert(lastMsg.content === "Hi", "only text remains");
}

function testAnthropicSingleTextFlat() {
  console.log("\n[Test] anthropic: single text part -> string content");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  const lastMsg = req.messages[req.messages.length - 1];
  assert(typeof lastMsg.content === "string", "flattens to string");
  assert(lastMsg.content === "Hello", "text matches");
}

function testAnthropicStringInput() {
  console.log("\n[Test] anthropic: string input -> single user message");
  const req = anthropic.buildUpstreamRequest(
    { model: "claude-sonnet-4-20250514", input: "Hello" },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.messages.length === 1, "one message");
  assert(req.messages[0].role === "user", "role is user");
  assert(req.messages[0].content === "Hello", "content matches");
}

function testAnthropicDefaultMaxTokens() {
  console.log("\n[Test] anthropic: default max_tokens=8192");
  const req = anthropic.buildUpstreamRequest({ model: "claude-sonnet-4-20250514", input: "Hi" }, { model: "claude-sonnet-4-20250514" }, {});
  assert(req.max_tokens === 8192, "default max_tokens is 8192");
}

function testAnthropicMessageTypeSystem() {
  console.log("\n[Test] anthropic: message-type system role extracted to system field");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [
        { type: "message", role: "system", content: "You are a poet." },
        { type: "message", role: "user", content: "Write a haiku" },
      ],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.system === "You are a poet.", "system from message-type");
  assert(req.messages.length === 1, "one user message");
  assert(req.messages[0].content === "Write a haiku", "user content preserved");
}

// ===========================================================================
// 3. SSE Bridge tests
// ===========================================================================

function testSseBridgeHeaders() {
  console.log("\n[Test] sse-bridge: writes proper SSE headers");
  const res = makeMockResponse();
  createSseBridge(res, "resp_001", "test-model");
  assert(res._head !== null, "writeHead was called");
  assert(res._head.code === 200, "status 200");
  assert(res._head.headers["Content-Type"] === "text/event-stream; charset=utf-8", "content-type is event-stream");
  assert(res._head.headers["Cache-Control"] === "no-cache, no-transform", "cache-control set");
  assert(res._head.headers["Connection"] === "keep-alive", "connection keep-alive");
  assert(res._head.headers["X-Accel-Buffering"] === "no", "x-accel-buffering");
}

function testSseBridgeResponseCreated() {
  console.log("\n[Test] sse-bridge: response.created event emitted first");
  const res = makeMockResponse();
  createSseBridge(res, "resp_001", "test-model");
  const events = parseSseResponse(res);
  assert(events.length >= 2, "at least 2 events");
  assert(events[0].event === "response.created", "first event is response.created");
  assert(events[0].data.type === "response.created", "data type correct");
  assert(events[0].data.response.id === "resp_001", "response id correct");
  assert(events[0].data.response.model === "test-model", "model correct");
  assert(events[0].data.response.status === "in_progress", "status is in_progress");
}

function testSseBridgeResponseInProgress() {
  console.log("\n[Test] sse-bridge: response.in_progress event emitted second");
  const res = makeMockResponse();
  createSseBridge(res, "resp_001", "test-model");
  const events = parseSseResponse(res);
  assert(events.length >= 2, "at least 2 events");
  assert(events[1].event === "response.in_progress", "second event is response.in_progress");
  assert(events[1].data.type === "response.in_progress", "data type correct");
  assert(events[1].data.response.id === "resp_001", "response id correct");
}

function testSseBridgeReasoningDelta() {
  console.log("\n[Test] sse-bridge: reasoning delta creates reasoning item");
  const res = makeMockResponse();
  const bridge = createSseBridge(res, "resp_001", "test-model");
  bridge.handleEvent(events.reasoningDeltaEvent("Let me think..."));
  // Find reasoning events in captured output (skip initial 2)
  const sseEvents = parseSseResponse(res);
  const addedEvent = sseEvents.find(function (e) {
    return e.event === "response.output_item.added" && e.data.item.type === "reasoning";
  });
  assert(addedEvent !== undefined, "reasoning output_item.added emitted");
  const summaryEvent = sseEvents.find(function (e) {
    return e.event === "response.reasoning_summary_part.added";
  });
  assert(summaryEvent !== undefined, "reasoning_summary_part.added emitted");
  const deltaEvent = sseEvents.find(function (e) {
    return e.event === "response.reasoning_summary_text.delta";
  });
  assert(deltaEvent !== undefined, "reasoning_summary_text.delta emitted");
  assert(deltaEvent.data.delta === "Let me think...", "delta matches");
}

function testSseBridgeTextDelta() {
  console.log("\n[Test] sse-bridge: text delta creates message item");
  const res = makeMockResponse();
  const bridge = createSseBridge(res, "resp_001", "test-model");
  bridge.handleEvent(events.textDeltaEvent("Hello!"));
  const sseEvents = parseSseResponse(res);
  const addedEvent = sseEvents.find(function (e) {
    return e.event === "response.output_item.added" && e.data.item.type === "message";
  });
  assert(addedEvent !== undefined, "message output_item.added emitted");
  const contentEvent = sseEvents.find(function (e) {
    return e.event === "response.content_part.added";
  });
  assert(contentEvent !== undefined, "content_part.added emitted");
  const deltaEvent = sseEvents.find(function (e) {
    return e.event === "response.output_text.delta";
  });
  assert(deltaEvent !== undefined, "output_text.delta emitted");
  assert(deltaEvent.data.delta === "Hello!", "delta matches");
}

function testSseBridgeTextAfterReasoning() {
  console.log("\n[Test] sse-bridge: text delta after reasoning closes reasoning");
  const res = makeMockResponse();
  const bridge = createSseBridge(res, "resp_001", "test-model");
  bridge.handleEvent(events.reasoningDeltaEvent("thinking..."));
  bridge.handleEvent(events.textDeltaEvent("answer"));
  const sseEvents = parseSseResponse(res);
  // Check that reasoning was closed (reasoning_summary_text.done emitted)
  const reasoningDone = sseEvents.find(function (e) {
    return e.event === "response.reasoning_summary_text.done";
  });
  assert(reasoningDone !== undefined, "reasoning_summary_text.done emitted when text starts");
  assert(reasoningDone.data.text === "thinking...", "full reasoning text captured");
  // Also check that output_item.done for reasoning emitted
  const itemDone = sseEvents.find(function (e) {
    return e.event === "response.output_item.done" && e.data.item.type === "reasoning";
  });
  assert(itemDone !== undefined, "reasoning output_item.done emitted");
}

function testSseBridgeToolCallStart() {
  console.log("\n[Test] sse-bridge: tool_call_start -> function_call item");
  const res = makeMockResponse();
  const bridge = createSseBridge(res, "resp_001", "test-model");
  bridge.handleEvent(events.toolCallStartEvent("call_abc", "get_weather"));
  const sseEvents = parseSseResponse(res);
  const addedEvent = sseEvents.find(function (e) {
    return e.event === "response.output_item.added" && e.data.item.type === "function_call";
  });
  assert(addedEvent !== undefined, "function_call output_item.added emitted");
  assert(addedEvent.data.item.name === "get_weather", "name correct");
  assert(addedEvent.data.item.call_id === "call_abc", "call_id correct");
}

function testSseBridgeToolCallArgsDelta() {
  console.log("\n[Test] sse-bridge: tool_call_args_delta appends args");
  const res = makeMockResponse();
  const bridge = createSseBridge(res, "resp_001", "test-model");
  bridge.handleEvent(events.toolCallStartEvent("call_abc", "get_weather"));
  bridge.handleEvent(events.toolCallArgsDeltaEvent("call_abc", '{"city'));
  bridge.handleEvent(events.toolCallArgsDeltaEvent("call_abc", '":"NYC"}'));
  const sseEvents = parseSseResponse(res);
  const deltas = sseEvents.filter(function (e) {
    return e.event === "response.function_call_arguments.delta";
  });
  assert(deltas.length === 2, "two arg delta events");
  assert(deltas[0].data.delta === '{"city', "first delta correct");
  assert(deltas[1].data.delta === '":"NYC"}', "second delta correct");
}

function testSseBridgeToolCallEnd() {
  console.log("\n[Test] sse-bridge: tool_call_end -> function_call completed");
  const res = makeMockResponse();
  const bridge = createSseBridge(res, "resp_001", "test-model");
  bridge.handleEvent(events.toolCallStartEvent("call_abc", "get_weather"));
  bridge.handleEvent(events.toolCallEndEvent("call_abc", "get_weather", '{"city":"NYC"}'));
  const sseEvents = parseSseResponse(res);
  const doneEvent = sseEvents.find(function (e) {
    return e.event === "response.function_call_arguments.done";
  });
  assert(doneEvent !== undefined, "function_call_arguments.done emitted");
  assert(doneEvent.data.arguments === '{"city":"NYC"}', "arguments captured");
  const itemDone = sseEvents.find(function (e) {
    return e.event === "response.output_item.done" && e.data.item.type === "function_call";
  });
  assert(itemDone !== undefined, "output_item.done emitted");
  assert(itemDone.data.item.status === "completed", "status completed");
}

function testSseBridgeResponseCompleted() {
  console.log("\n[Test] sse-bridge: response.completed emits with usage");
  const res = makeMockResponse();
  const bridge = createSseBridge(res, "resp_001", "test-model");
  bridge.handleEvent(events.textDeltaEvent("Hello"));
  bridge.handleEvent(events.responseCompletedEvent({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }));
  const sseEvents = parseSseResponse(res);
  const completedEvent = sseEvents.find(function (e) {
    return e.event === "response.completed";
  });
  assert(completedEvent !== undefined, "response.completed emitted");
  assert(completedEvent.data.response.status === "completed", "status completed");
  assert(completedEvent.data.response.usage.input_tokens === 10, "usage input_tokens");
  assert(completedEvent.data.response.usage.output_tokens === 5, "usage output_tokens");
  // Check for [DONE] signal
  assert(res.written.join("").indexOf("data: [DONE]") !== -1, "[DONE] written");
  assert(res.ended === true, "response ended");
}

function testSseBridgeError() {
  console.log("\n[Test] sse-bridge: error emits response.failed");
  const res = makeMockResponse();
  const bridge = createSseBridge(res, "resp_001", "test-model");
  bridge.handleEvent(events.errorEvent("Something went wrong", "api_error"));
  const sseEvents = parseSseResponse(res);
  const failedEvent = sseEvents.find(function (e) {
    return e.event === "response.failed";
  });
  assert(failedEvent !== undefined, "response.failed emitted");
  assert(failedEvent.data.response.status === "failed", "status failed");
  assert(failedEvent.data.response.error.message === "Something went wrong", "error message");
  assert(failedEvent.data.response.error.code === "api_error", "error code");
  assert(res.ended === true, "response ended");
}

function testSseBridgeWriteAfterEnd() {
  console.log("\n[Test] sse-bridge: write-after-end guard");
  const res = makeMockResponse();
  // Set writableEnded to simulate a closed connection
  res.writableEnded = true;
  const bridge = createSseBridge(res, "resp_001", "test-model");
  // This should NOT throw
  let threw = false;
  try {
    bridge.handleEvent(events.textDeltaEvent("Should be ignored"));
  } catch {
    threw = true;
  }
  assert(threw === false, "no error thrown when writing to ended response");
  // Verify no new writes beyond the initial setup
  const sseEvents = parseSseResponse(res);
  const textDeltas = sseEvents.filter(function (e) {
    return e.event === "response.output_text.delta";
  });
  assert(textDeltas.length === 0, "no text delta events when writableEnded");
}

function testSseBridgeOutputTracking() {
  console.log("\n[Test] sse-bridge: output array tracks completed items");
  const res = makeMockResponse();
  const bridge = createSseBridge(res, "resp_002", "test-model");
  bridge.handleEvent(events.textDeltaEvent("Hello world"));
  bridge.handleEvent(events.responseCompletedEvent(null));
  assert(Array.isArray(bridge.output), "output is an array");
  assert(bridge.output.length === 1, "one output item");
  assert(bridge.output[0].type === "message", "output is message");
  assert(bridge.output[0].status === "completed", "status completed");
  assert(bridge.output[0].content[0].text === "Hello world", "text captured");
}

// ===========================================================================
// 4. Events tests
// ===========================================================================

function testEventTypeEnum() {
  console.log("\n[Test] events: EventType enum has all 8 values");
  const et = events.EventType;
  assert(et.RESPONSE_CREATED === "response_created", "RESPONSE_CREATED");
  assert(et.REASONING_DELTA === "reasoning_delta", "REASONING_DELTA");
  assert(et.TEXT_DELTA === "text_delta", "TEXT_DELTA");
  assert(et.TOOL_CALL_START === "tool_call_start", "TOOL_CALL_START");
  assert(et.TOOL_CALL_ARGS_DELTA === "tool_call_args_delta", "TOOL_CALL_ARGS_DELTA");
  assert(et.TOOL_CALL_END === "tool_call_end", "TOOL_CALL_END");
  assert(et.RESPONSE_COMPLETED === "response_completed", "RESPONSE_COMPLETED");
  assert(et.ERROR === "error", "ERROR");
  assert(Object.keys(et).length === 12, "exactly 12 values");
}

function testResponseCreatedEvent() {
  console.log("\n[Test] events: responseCreatedEvent factory");
  const ev = events.responseCreatedEvent({ id: "r1" });
  assert(ev.type === "response_created", "type correct");
  assert(ev.meta.id === "r1", "meta passed through");
}

function testReasoningDeltaEvent() {
  console.log("\n[Test] events: reasoningDeltaEvent factory");
  const ev = events.reasoningDeltaEvent("thinking...");
  assert(ev.type === "reasoning_delta", "type correct");
  assert(ev.delta === "thinking...", "delta correct");
}

function testTextDeltaEvent() {
  console.log("\n[Test] events: textDeltaEvent factory");
  const ev = events.textDeltaEvent("hello");
  assert(ev.type === "text_delta", "type correct");
  assert(ev.delta === "hello", "delta correct");
}

function testToolCallStartEvent() {
  console.log("\n[Test] events: toolCallStartEvent factory");
  const ev = events.toolCallStartEvent("id1", "func_name");
  assert(ev.type === "tool_call_start", "type correct");
  assert(ev.callId === "id1", "callId correct");
  assert(ev.name === "func_name", "name correct");
}

function testToolCallArgsDeltaEvent() {
  console.log("\n[Test] events: toolCallArgsDeltaEvent factory");
  const ev = events.toolCallArgsDeltaEvent("id1", '{"a":1}');
  assert(ev.type === "tool_call_args_delta", "type correct");
  assert(ev.callId === "id1", "callId correct");
  assert(ev.delta === '{"a":1}', "delta correct");
}

function testToolCallEndEvent() {
  console.log("\n[Test] events: toolCallEndEvent factory");
  const ev = events.toolCallEndEvent("id1", "func_name", '{"a":1}');
  assert(ev.type === "tool_call_end", "type correct");
  assert(ev.callId === "id1", "callId correct");
  assert(ev.name === "func_name", "name correct");
  assert(ev.args === '{"a":1}', "args correct");
}

function testResponseCompletedEvent() {
  console.log("\n[Test] events: responseCompletedEvent factory");
  const ev = events.responseCompletedEvent({ input_tokens: 10 });
  assert(ev.type === "response_completed", "type correct");
  assert(ev.usage.input_tokens === 10, "usage passed through");
}

function testErrorEvent() {
  console.log("\n[Test] events: errorEvent factory");
  const ev = events.errorEvent("bad", "code_x");
  assert(ev.type === "error", "type correct");
  assert(ev.message === "bad", "message correct");
  assert(ev.code === "code_x", "code correct");
}

// ===========================================================================
// 5. Reasoning cache tests
// ===========================================================================

function testReasoningCacheStoreGet() {
  console.log("\n[Test] reasoning-cache: store + get roundtrip");
  const text = "The answer is 42.";
  const sig = "sig_abc123";
  reasoningCache.store(text, sig);
  const result = reasoningCache.get(text);
  assert(result === sig, "get returns stored signature");
}

function testReasoningCacheGetNull() {
  console.log("\n[Test] reasoning-cache: get returns null for unknown text");
  const result = reasoningCache.get("text never stored before");
  assert(result === null, "null for unknown text");
}

function testReasoningCacheMultiplePairs() {
  console.log("\n[Test] reasoning-cache: multiple store/get pairs");
  reasoningCache.store("Think about math.", "sig_math");
  reasoningCache.store("Think about code.", "sig_code");
  assert(reasoningCache.get("Think about math.") === "sig_math", "first pair correct");
  assert(reasoningCache.get("Think about code.") === "sig_code", "second pair correct");
  assert(reasoningCache.get("think about nothing") === null, "unknown still null");
}

// ===========================================================================
// 6. Shared utilities tests (http.js)
// ===========================================================================

function testMakeId() {
  console.log("\n[Test] http: makeId produces prefixed hex strings");
  const id = makeId("msg");
  assert(typeof id === "string", "returns string");
  assert(id.indexOf("msg_") === 0, "starts with prefix");
  const hexPart = id.slice(4);
  assert(hexPart.length === 24, "24 hex chars (12 bytes)");
  // Should be all hex characters
  assert(/^[0-9a-f]+$/.test(hexPart), "all hex");
}

function testMakeIdUnique() {
  console.log("\n[Test] http: makeId produces unique IDs");
  const id1 = makeId("msg");
  const id2 = makeId("msg");
  assert(id1 !== id2, "two IDs are different");
}

function testCreateSequence() {
  console.log("\n[Test] http: createSequence produces incrementing numbers");
  const seq = createSequence();
  assert(seq.next() === 0, "first is 0");
  assert(seq.next() === 1, "second is 1");
  assert(seq.next() === 2, "third is 2");
}

function testCreateSequenceIndependent() {
  console.log("\n[Test] http: createSequence instances are independent");
  const a = createSequence();
  const b = createSequence();
  a.next();
  a.next();
  b.next();
  assert(a.next() === 2, "a=2");
  assert(b.next() === 1, "b=1");
}

function testEmitSse() {
  console.log("\n[Test] http: emitSse formats correctly");
  const res = makeMockResponse();
  emitSse(res, "test.event", { value: 42 });
  const full = res.written.join("");
  assert(full.indexOf("event: test.event\n") === 0, "starts with event line");
  assert(full.indexOf("data: ") !== -1, "has data line");
  assert(full.indexOf('{"value":42}') !== -1, "JSON data correct");
}

// ===========================================================================
// 7. Stream parser tests (stream.js)
// ===========================================================================

async function testParseSSEStreamBasic() {
  console.log("\n[Test] stream: parseSSEStream yields data payloads");
  const chunks = ["data: hello world\n\n"];
  const body = makeAsyncIterable(chunks);
  const results = [];
  for await (const payload of parseSSEStream(body)) {
    results.push(payload);
  }
  assert(results.length === 1, "one payload yielded");
  assert(results[0] === "hello world", "payload correct");
}

async function testParseSSEStreamMultiChunk() {
  console.log("\n[Test] stream: handles multi-chunk messages");
  // Split a single SSE message across chunks
  const chunks = ["data: hello", " world\n\n"];
  const body = makeAsyncIterable(chunks);
  const results = [];
  for await (const payload of parseSSEStream(body)) {
    results.push(payload);
  }
  assert(results.length === 1, "one payload yielded");
  assert(results[0] === "hello world", "payload reassembled correctly");
}

async function testParseSSEStreamMultipleMessages() {
  console.log("\n[Test] stream: handles multiple SSE messages");
  const chunks = ["data: first\n\ndata: second\n\n"];
  const body = makeAsyncIterable(chunks);
  const results = [];
  for await (const payload of parseSSEStream(body)) {
    results.push(payload);
  }
  assert(results.length === 2, "two payloads");
  assert(results[0] === "first", "first payload");
  assert(results[1] === "second", "second payload");
}

async function testParseSSEStreamIgnoresComments() {
  console.log("\n[Test] stream: ignores comments (lines starting with :)");
  const chunks = [": this is a comment\ndata: real payload\n\n"];
  const body = makeAsyncIterable(chunks);
  const results = [];
  for await (const payload of parseSSEStream(body)) {
    results.push(payload);
  }
  assert(results.length === 1, "one payload (comment ignored)");
  assert(results[0] === "real payload", "payload correct");
}

async function testParseSSEStreamTrailingBuffer() {
  console.log("\n[Test] stream: handles trailing buffer without final newline");
  const chunks = ["data: trailing"];
  const body = makeAsyncIterable(chunks);
  const results = [];
  for await (const payload of parseSSEStream(body)) {
    results.push(payload);
  }
  assert(results.length === 1, "trailing buffer yielded");
  assert(results[0] === "trailing", "payload correct");
}

async function testParseSSEStreamEmptyAndBlankLines() {
  console.log("\n[Test] stream: skips empty and blank lines");
  const chunks = ["\n\ndata: only\n\n\n\ndata: two\n\n"];
  const body = makeAsyncIterable(chunks);
  const results = [];
  for await (const payload of parseSSEStream(body)) {
    results.push(payload);
  }
  assert(results.length === 2, "two payloads despite blanks");
  assert(results[0] === "only", "first");
  assert(results[1] === "two", "second");
}

// ===========================================================================
// 8. Presets tests
// ===========================================================================

function testGetPreset() {
  console.log("\n[Test] presets: getPreset returns correct preset");
  const p = presets.getPreset("openai-chat");
  assert(p !== null, "preset found");
  assert(p.id === "openai-chat", "id matches");
  assert(p.name === "OpenAI Chat", "name matches");
  assert(p.protocol === "openai-chat", "protocol matches");
}

function testGetPresetUnknown() {
  console.log("\n[Test] presets: getPreset returns null for unknown");
  const p = presets.getPreset("nonexistent");
  assert(p === null, "null for unknown preset");
}

function testResolvePresetByPreset() {
  console.log("\n[Test] presets: resolvePreset resolves by preset property");
  const p = presets.resolvePreset({ preset: "deepseek" });
  assert(p !== null, "preset found");
  assert(p.id === "deepseek", "deepseek preset resolved");
}

function testResolvePresetFallbackToProtocol() {
  console.log("\n[Test] presets: resolvePreset falls back to protocol");
  const p = presets.resolvePreset({ protocol: "anthropic" });
  assert(p !== null, "fallback preset found");
  assert(p.id === "anthropic", "anthropic preset from protocol fallback");
}

function testResolvePresetNull() {
  console.log("\n[Test] presets: resolvePreset returns null for nothing matching");
  const p = presets.resolvePreset({});
  assert(p === null, "null for no match");
}

function testGetQuickPresets() {
  console.log("\n[Test] presets: getQuickPresets returns only vendor presets (with hooks)");
  const list = presets.getQuickPresets();
  assert(Array.isArray(list), "returns array");
  assert(list.length >= 3, "at least 3 presets (deepseek, kimi, kimi-coding)");
  const ids = list.map(function (p) {
    return p.id;
  });
  // Protocol templates (openai-chat, anthropic) are excluded — UI provides a "Custom" button instead
  assert(ids.indexOf("openai-chat") === -1, "openai-chat excluded (now handled by Custom button)");
  assert(ids.indexOf("anthropic") === -1, "anthropic excluded (now handled by Custom button)");
  assert(ids.indexOf("deepseek") !== -1, "contains deepseek");
  assert(ids.indexOf("kimi") !== -1, "contains kimi");
  // Check deepseek has models
  const ds = list.find(function (p) {
    return p.id === "deepseek";
  });
  assert(ds.models.length > 0, "deepseek has models array");
  // deepseek and kimi-coding have hooks (vendor: true), kimi uses vendor: false (no hooks)
  var ds2 = list.find(function (p) { return p.id === "deepseek"; });
  assert(ds2.vendor === true, "deepseek is a vendor preset");
  var kc = list.find(function (p) { return p.id === "kimi-coding"; });
  assert(kc.vendor === true, "kimi-coding is a vendor preset");
}

function testGetVariantBaseUrl() {
  console.log("\n[Test] presets: getVariantBaseUrl returns variant URL when available");
  const url = presets.getVariantBaseUrl({ preset: "deepseek" }, "anthropic");
  assert(url === "https://api.deepseek.com/anthropic", "variant URL for deepseek anthropic");
}

function testGetVariantBaseUrlFallback() {
  console.log("\n[Test] presets: getVariantBaseUrl falls back to baseUrl when variant missing");
  const url = presets.getVariantBaseUrl({ preset: "deepseek" }, "nonexistent-protocol");
  assert(url === "https://api.deepseek.com/v1", "falls back to default baseUrl");
}

function testGetHooks() {
  console.log("\n[Test] presets: getHooks returns hooks for vendor preset");
  const hooks = presets.getHooks({ preset: "deepseek" });
  assert(hooks !== null, "hooks returned for deepseek");
  assert(typeof hooks === "object", "hooks is an object");
}

function testGetHooksNull() {
  console.log("\n[Test] presets: getHooks returns null for non-vendor preset");
  const hooks = presets.getHooks({ protocol: "openai-chat" });
  assert(hooks === null, "null hooks for protocol template");
}

// ===========================================================================
// 9. Edge cases
// ===========================================================================

function testOpenAIChatEmptyContentParts() {
  console.log("\n[Test] edge: openai-chat empty content parts produce empty string");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [{ role: "user", content: [] }],
    },
    { model: "gpt-4o" },
    {},
  );
  const msg = payload.messages[0];
  assert(msg.role === "user", "role is user");
  assert(msg.content === "", "empty content string");
}

function testOpenAIChatUndefinedContent() {
  console.log("\n[Test] edge: openai-chat handling of null/undefined items in input");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [null, undefined, { role: "user", content: "valid" }],
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.messages.length === 1, "null/undefined items skipped");
  assert(payload.messages[0].content === "valid", "valid message kept");
}

function testOpenAIChatEmptyToolsArray() {
  console.log("\n[Test] edge: openai-chat empty tools array -> no tools field");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: "Hi", tools: [] }, { model: "gpt-4o" }, {});
  assert(payload.tools === undefined, "no tools when array empty");
}

function testUnicodeText() {
  console.log("\n[Test] edge: unicode text handled correctly");
  const payload = openai.buildUpstreamRequest({ model: "gpt-4o", input: "你好 世界" }, { model: "gpt-4o" }, {});
  assert(payload.messages[0].content === "你好 世界", "Chinese text preserved");
}

function testUnicodeTextInParts() {
  console.log("\n[Test] edge: unicode in content parts");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [{ role: "user", content: [{ type: "input_text", text: "éàü" }] }],
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.messages[0].content === "éàü", "accented chars preserved");
}

function testAnthropicTemperatureZero() {
  console.log("\n[Test] edge: anthropic temperature=0 passes through");
  const req = anthropic.buildUpstreamRequest(
    { model: "claude-sonnet-4-20250514", input: "Hi", temperature: 0 },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.temperature === 0, "temperature=0 preserved");
}

function testAnthropicStreamExplicitFalse() {
  console.log("\n[Test] edge: anthropic stream:false respected");
  const req = anthropic.buildUpstreamRequest(
    { model: "claude-sonnet-4-20250514", input: "Hi", stream: false },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.stream === false, "stream is false");
}

function testOpenAIChatNoProviderModel() {
  console.log("\n[Test] edge: openai-chat uses requestBody.model when provider.model absent");
  const payload = openai.buildUpstreamRequest({ model: "my-model", input: "Hi" }, {}, {});
  assert(payload.model === "my-model", "falls back to requestBody.model");
}

function testAnthropicNoProviderModel() {
  console.log("\n[Test] edge: anthropic uses requestBody.model when provider.model absent");
  const req = anthropic.buildUpstreamRequest({ model: "my-claude", input: "Hi" }, {}, {});
  assert(req.model === "my-claude", "falls back to requestBody.model");
}

function testAnthropicFunctionCallDefaultArguments() {
  console.log("\n[Test] edge: anthropic function_call with no arguments");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: [{ type: "function_call", call_id: "call_x", name: "do_thing" }],
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  const asst = req.messages.find(function (m) {
    return m.role === "assistant";
  });
  assert(asst !== undefined, "assistant message exists");
  assert(asst.content[0].type === "tool_use", "tool_use block");
  assert(typeof asst.content[0].input === "object", "empty input defaults to {}");
}

function testOpenAIChatEmptyToolOutput() {
  console.log("\n[Test] edge: openai-chat function_call_output with empty output");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [{ type: "function_call_output", call_id: "call_x", output: "" }],
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.messages[0].content === "", "empty output preserved as empty string");
}

function testOpenAIChatOutputTextPart() {
  console.log("\n[Test] edge: openai-chat handles output_text content part type");
  const payload = openai.buildUpstreamRequest(
    {
      model: "gpt-4o",
      input: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "I think therefore I am" }],
        },
      ],
    },
    { model: "gpt-4o" },
    {},
  );
  assert(payload.messages[0].role === "assistant", "assistant role");
  assert(payload.messages[0].content === "I think therefore I am", "output_text flattened to string");
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log("=== Codex-Switch Comprehensive Unit Tests ===\n");

  // 1. OpenAI Chat Adapter
  console.log("--- 1. OpenAI Chat Adapter ---");
  testOpenAIChatStringInput();
  testOpenAIChatArrayInputRoleBased();
  testOpenAIChatArrayInputMessageType();
  testOpenAIChatInstructions();
  testOpenAIChatMaxOutputTokens();
  testOpenAIChatTemperatureTopP();
  testOpenAIChatTemperatureZero();
  testOpenAIChatReasoningEffort();
  testOpenAIChatJsonObjectFormat();
  testOpenAIChatJsonSchemaFormat();
  testOpenAIChatTools();
  testOpenAIChatToolsFiltersNonFunction();
  testOpenAIChatFunctionCallInput();
  testOpenAIChatFunctionCallOutputInput();
  testOpenAIChatFunctionCallOutputObject();
  testOpenAIChatImageUrlNonBase64();
  testOpenAIChatImageUrlBase64();
  testOpenAIChatSingleTextPartFlat();
  testOpenAIChatEmptyInput();
  testOpenAIChatEmptyInputArray();
  testOpenAIChatVisionFalse();
  testOpenAIChatMissingOptionalFields();
  testOpenAIChatStreamExplicitFalse();
  testOpenAIChatProviderModelOverride();
  testOpenAIChatStringInArray();

  // 2. Anthropic Adapter
  console.log("\n--- 2. Anthropic Adapter ---");
  testAnthropicInstructions();
  testAnthropicSystemRoleInput();
  testAnthropicSystemMerged();
  testAnthropicReasoningLow();
  testAnthropicReasoningMedium();
  testAnthropicReasoningHigh();
  testAnthropicReasoningXhigh();
  testAnthropicReasoningXhighLargeTokens();
  testAnthropicReasoningMax();
  testAnthropicNoReasoning();
  testAnthropicTools();
  testAnthropicFunctionCall();
  testAnthropicFunctionCallOutput();
  testAnthropicFunctionCallMerge();
  testAnthropicFunctionCallOutputMerge();
  testAnthropicImageDataUri();
  testAnthropicImageHttpUrl();
  testAnthropicSingleTextFlat();
  testAnthropicStringInput();
  testAnthropicDefaultMaxTokens();
  testAnthropicMessageTypeSystem();

  // 3. SSE Bridge
  console.log("\n--- 3. SSE Bridge ---");
  testSseBridgeHeaders();
  testSseBridgeResponseCreated();
  testSseBridgeResponseInProgress();
  testSseBridgeReasoningDelta();
  testSseBridgeTextDelta();
  testSseBridgeTextAfterReasoning();
  testSseBridgeToolCallStart();
  testSseBridgeToolCallArgsDelta();
  testSseBridgeToolCallEnd();
  testSseBridgeResponseCompleted();
  testSseBridgeError();
  testSseBridgeWriteAfterEnd();
  testSseBridgeOutputTracking();

  // 4. Events
  console.log("\n--- 4. Events ---");
  testEventTypeEnum();
  testResponseCreatedEvent();
  testReasoningDeltaEvent();
  testTextDeltaEvent();
  testToolCallStartEvent();
  testToolCallArgsDeltaEvent();
  testToolCallEndEvent();
  testResponseCompletedEvent();
  testErrorEvent();

  // 5. Reasoning Cache
  console.log("\n--- 5. Reasoning Cache ---");
  testReasoningCacheStoreGet();
  testReasoningCacheGetNull();
  testReasoningCacheMultiplePairs();

  // 6. Shared Utilities
  console.log("\n--- 6. Shared Utilities (http.js) ---");
  testMakeId();
  testMakeIdUnique();
  testCreateSequence();
  testCreateSequenceIndependent();
  testEmitSse();

  // 7. Stream Parser (async)
  console.log("\n--- 7. Stream Parser (stream.js) ---");
  await testParseSSEStreamBasic();
  await testParseSSEStreamMultiChunk();
  await testParseSSEStreamMultipleMessages();
  await testParseSSEStreamIgnoresComments();
  await testParseSSEStreamTrailingBuffer();
  await testParseSSEStreamEmptyAndBlankLines();

  // 8. Presets
  console.log("\n--- 8. Presets ---");
  testGetPreset();
  testGetPresetUnknown();
  testResolvePresetByPreset();
  testResolvePresetFallbackToProtocol();
  testResolvePresetNull();
  testGetQuickPresets();
  testGetVariantBaseUrl();
  testGetVariantBaseUrlFallback();
  testGetHooks();
  testGetHooksNull();

  // 9. Edge Cases
  console.log("\n--- 9. Edge Cases ---");
  testOpenAIChatEmptyContentParts();
  testOpenAIChatUndefinedContent();
  testOpenAIChatEmptyToolsArray();
  testUnicodeText();
  testUnicodeTextInParts();
  testAnthropicTemperatureZero();
  testAnthropicStreamExplicitFalse();
  testOpenAIChatNoProviderModel();
  testAnthropicNoProviderModel();
  testAnthropicFunctionCallDefaultArguments();
  testOpenAIChatEmptyToolOutput();
  testOpenAIChatOutputTextPart();

  console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (err) {
  console.error("Test runner error:", err);
  process.exit(2);
});
