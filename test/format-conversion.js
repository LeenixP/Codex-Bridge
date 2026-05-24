"use strict";

const { buildUpstreamRequest } = require("../src/proxy/adapters/openai-chat");
const anthropic = require("../src/proxy/adapters/anthropic");

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

// --- OpenAI Chat multimodal ---

function testOpenAIMultimodalImage() {
  console.log("\n[Test] OpenAI Chat image_url conversion");
  const requestBody = {
    model: "gpt-4o",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "What's in this image?" },
          { type: "input_image", image_url: "https://example.com/photo.jpg" },
        ],
      },
    ],
    stream: false,
  };
  const payload = buildUpstreamRequest(requestBody, { model: "gpt-4o" }, {});
  const lastMessage = payload.messages[payload.messages.length - 1];
  assert(Array.isArray(lastMessage.content), "content is an array (multimodal)");
  const textPart = lastMessage.content.find((p) => p.type === "text");
  assert(textPart !== undefined, "has text part");
  assert(textPart.text === "What's in this image?", "text content preserved");
  const imagePart = lastMessage.content.find((p) => p.type === "image_url");
  assert(imagePart !== undefined, "has image_url part");
  assert(imagePart.image_url.url === "https://example.com/photo.jpg", "image URL preserved");
}

function testOpenAIMultimodalBase64Image() {
  console.log("\n[Test] OpenAI Chat base64 image conversion");
  const requestBody = {
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
    stream: false,
  };
  const payload = buildUpstreamRequest(requestBody, { model: "gpt-4o" }, {});
  const lastMessage = payload.messages[payload.messages.length - 1];
  const imagePart = lastMessage.content.find((p) => p.type === "image_url");
  assert(imagePart !== undefined, "has image_url part for base64");
  assert(imagePart.image_url.url.startsWith("data:image/png;base64,"), "base64 data URI preserved");
}

function testOpenAIPlainTextShortcut() {
  console.log("\n[Test] OpenAI Chat single text part flattens to string");
  const requestBody = {
    model: "gpt-4o",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      },
    ],
    stream: false,
  };
  const payload = buildUpstreamRequest(requestBody, { model: "gpt-4o" }, {});
  const lastMessage = payload.messages[payload.messages.length - 1];
  assert(typeof lastMessage.content === "string", "single text part flattens to string");
  assert(lastMessage.content === "Hello", "text matches");
}

// --- Anthropic multimodal ---

function testAnthropicMultimodalImage() {
  console.log("\n[Test] Anthropic image source conversion");
  const requestBody = {
    model: "claude-sonnet-4-20250514",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "What's in this image?" },
          { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQ=" },
        ],
      },
    ],
    stream: false,
  };
  const req = anthropic.buildUpstreamRequest(requestBody, { model: "claude-sonnet-4-20250514" }, {});
  const lastMessage = req.messages[req.messages.length - 1];
  assert(Array.isArray(lastMessage.content), "content is an array (multimodal)");
  const textPart = lastMessage.content.find((p) => p.type === "text");
  assert(textPart !== undefined, "has text part");
  assert(textPart.text === "What's in this image?", "text content preserved");
  const imagePart = lastMessage.content.find((p) => p.type === "image");
  assert(imagePart !== undefined, "has image part");
  assert(imagePart.source.type === "base64", "source type is base64");
  assert(imagePart.source.media_type === "image/jpeg", "media_type is image/jpeg");
  assert(imagePart.source.data === "/9j/4AAQ=", "base64 data extracted");
}

function testAnthropicSkipsNonDataUri() {
  console.log("\n[Test] Anthropic skips non-data-URI images");
  const requestBody = {
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
    stream: false,
  };
  const req = anthropic.buildUpstreamRequest(requestBody, { model: "claude-sonnet-4-20250514" }, {});
  const lastMessage = req.messages[req.messages.length - 1];
  assert(typeof lastMessage.content === "string", "non-data-URI image skipped, content flattens to string");
  assert(lastMessage.content === "Hi", "only text remains");
}

// --- OpenAI Chat response_format ---

function testOpenAIJsonObjectFormat() {
  console.log("\n[Test] OpenAI Chat json_object response_format");
  const requestBody = {
    model: "gpt-4o",
    input: "Return JSON",
    stream: false,
    text: { format: { type: "json_object" } },
  };
  const payload = buildUpstreamRequest(requestBody, { model: "gpt-4o" }, {});
  assert(payload.response_format !== undefined, "has response_format");
  assert(payload.response_format.type === "json_object", "type is json_object");
}

function testOpenAIJsonSchemaFormat() {
  console.log("\n[Test] OpenAI Chat json_schema response_format");
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const requestBody = {
    model: "gpt-4o",
    input: "Return JSON with schema",
    stream: false,
    text: { format: { type: "json_schema", name: "person", strict: true, schema } },
  };
  const payload = buildUpstreamRequest(requestBody, { model: "gpt-4o" }, {});
  assert(payload.response_format !== undefined, "has response_format");
  assert(payload.response_format.type === "json_schema", "type is json_schema");
  assert(payload.response_format.json_schema.name === "person", "name is preserved");
  assert(payload.response_format.json_schema.strict === true, "strict is preserved");
  assert(payload.response_format.json_schema.schema === schema, "schema is preserved");
}

function testOpenAINoFormat() {
  console.log("\n[Test] OpenAI Chat no response_format when absent");
  const requestBody = { model: "gpt-4o", input: "Hi", stream: false };
  const payload = buildUpstreamRequest(requestBody, { model: "gpt-4o" }, {});
  assert(payload.response_format === undefined, "no response_format when not requested");
}

// --- Anthropic system extraction ---

function testAnthropicSystemFromInstructions() {
  console.log("\n[Test] Anthropic system from instructions");
  const requestBody = {
    model: "claude-sonnet-4-20250514",
    input: "Hello",
    instructions: "You are a helpful assistant.",
    stream: false,
  };
  const req = anthropic.buildUpstreamRequest(requestBody, { model: "claude-sonnet-4-20250514" }, {});
  assert(req.system !== undefined, "has system field");
  assert(req.system === "You are a helpful assistant.", "system matches instructions");
}

function testAnthropicSystemFromInputRole() {
  console.log("\n[Test] Anthropic system from input system-role message");
  const requestBody = {
    model: "claude-sonnet-4-20250514",
    input: [
      { role: "system", content: "You speak French." },
      { role: "user", content: "Bonjour" },
    ],
    stream: false,
  };
  const req = anthropic.buildUpstreamRequest(requestBody, { model: "claude-sonnet-4-20250514" }, {});
  assert(req.system !== undefined, "has system field");
  assert(req.system === "You speak French.", "system from input role");
  assert(req.messages.length === 1, "only user message in messages array");
  assert(req.messages[0].role === "user", "user message preserved");
}

function testAnthropicSystemMerged() {
  console.log("\n[Test] Anthropic merges instructions and system-role messages");
  const requestBody = {
    model: "claude-sonnet-4-20250514",
    input: [
      { role: "system", content: "You speak French." },
      { role: "user", content: "Bonjour" },
    ],
    instructions: "You are polite.",
    stream: false,
  };
  const req = anthropic.buildUpstreamRequest(requestBody, { model: "claude-sonnet-4-20250514" }, {});
  assert(req.system.includes("You are polite."), "system contains instructions");
  assert(req.system.includes("You speak French."), "system contains input system message");
  assert(req.system.includes("\n\n"), "system parts joined by double newline");
}

// --- Anthropic thinking budget ---

function testAnthropicThinkingLow() {
  console.log("\n[Test] Anthropic thinking budget: low");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: "Hi",
      stream: false,
      reasoning: { effort: "low" },
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking.budget_tokens === 2000, "low budget = 2000");
}

function testAnthropicThinkingHigh() {
  console.log("\n[Test] Anthropic thinking budget: high");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: "Hi",
      stream: false,
      reasoning: { effort: "high" },
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking.budget_tokens === 16000, "high budget = 16000");
}

function testAnthropicThinkingXhigh() {
  console.log("\n[Test] Anthropic thinking budget: xhigh capped");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: "Hi",
      stream: false,
      max_output_tokens: 8192,
      reasoning: { effort: "xhigh" },
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking.budget_tokens === 8191, "xhigh budget = max_tokens - 1 (capped at 32000)");
}

function testAnthropicNoThinking() {
  console.log("\n[Test] Anthropic no thinking when reasoning absent");
  const req = anthropic.buildUpstreamRequest(
    {
      model: "claude-sonnet-4-20250514",
      input: "Hi",
      stream: false,
    },
    { model: "claude-sonnet-4-20250514" },
    {},
  );
  assert(req.thinking === undefined, "no thinking block without reasoning config");
}

// --- Anthropic tool conversion ---

function testAnthropicToolConversion() {
  console.log("\n[Test] Anthropic tool definitions");
  const requestBody = {
    model: "claude-sonnet-4-20250514",
    input: "What's the weather?",
    stream: false,
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get current weather",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ],
  };
  const req = anthropic.buildUpstreamRequest(requestBody, { model: "claude-sonnet-4-20250514" }, {});
  assert(Array.isArray(req.tools) && req.tools.length === 1, "has one tool");
  assert(req.tools[0].name === "get_weather", "tool name matches");
  assert(req.tools[0].description === "Get current weather", "tool description matches");
  assert(req.tools[0].input_schema.required[0] === "city", "input_schema preserved");
}

function testAnthropicFunctionCallConversion() {
  console.log("\n[Test] Anthropic function_call → tool_use conversion");
  const requestBody = {
    model: "claude-sonnet-4-20250514",
    input: [{ type: "function_call", call_id: "call_123", name: "get_weather", arguments: '{"city":"London"}' }],
    stream: false,
  };
  const req = anthropic.buildUpstreamRequest(requestBody, { model: "claude-sonnet-4-20250514" }, {});
  const assistantMsg = req.messages.find((m) => m.role === "assistant");
  assert(assistantMsg !== undefined, "has assistant message");
  assert(Array.isArray(assistantMsg.content), "assistant content is array");
  const toolUse = assistantMsg.content[0];
  assert(toolUse.type === "tool_use", "content block is tool_use");
  assert(toolUse.id === "call_123", "call id preserved");
  assert(toolUse.name === "get_weather", "function name preserved");
  assert(toolUse.input.city === "London", "arguments parsed correctly");
}

function main() {
  console.log("=== Codex-Bridge Format & Conversion Tests ===");

  testOpenAIMultimodalImage();
  testOpenAIMultimodalBase64Image();
  testOpenAIPlainTextShortcut();
  testOpenAIJsonObjectFormat();
  testOpenAIJsonSchemaFormat();
  testOpenAINoFormat();

  testAnthropicMultimodalImage();
  testAnthropicSkipsNonDataUri();
  testAnthropicSystemFromInstructions();
  testAnthropicSystemFromInputRole();
  testAnthropicSystemMerged();
  testAnthropicThinkingLow();
  testAnthropicThinkingHigh();
  testAnthropicThinkingXhigh();
  testAnthropicNoThinking();
  testAnthropicToolConversion();
  testAnthropicFunctionCallConversion();

  console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

main();
