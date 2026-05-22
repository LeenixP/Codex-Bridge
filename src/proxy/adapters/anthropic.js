"use strict";

const { request } = require("undici");
const { parseSSEStream } = require("../../shared/stream");
const {
  reasoningDeltaEvent,
  textDeltaEvent,
  toolCallStartEvent,
  toolCallArgsDeltaEvent,
  toolCallEndEvent,
  responseCompletedEvent,
  errorEvent,
} = require("../core/events");

const EFFORT_TO_BUDGET = {
  low: 2000,
  medium: 8000,
  high: 16000,
};

/**
 * Build an Anthropic Messages request from a Codex Responses API request body.
 *
 * Converts Responses-format input into Anthropic Messages, mapping:
 *   instructions + system-role messages → top-level system field
 *   reasoning.effort → thinking budget_tokens (low=2000, medium=8000, high=16000, xhigh/max=32000)
 *   tools (function type) → Anthropic tool definitions with input_schema
 *   function_call → assistant tool_use content block
 *   function_call_output → user tool_result content block
 *   input_image content parts → Anthropic image source (requires base64 data URI)
 *
 * @param {object} requestBody - Codex Responses API request body
 * @param {string} requestBody.model - Model ID
 * @param {string|Array} requestBody.input - User input (string or content array)
 * @param {string} [requestBody.instructions] - System instructions
 * @param {boolean} [requestBody.stream=true] - Whether to stream
 * @param {number} [requestBody.max_output_tokens=8192] - Max tokens
 * @param {number} [requestBody.temperature] - Sampling temperature
 * @param {number} [requestBody.top_p] - Nucleus sampling parameter
 * @param {object} [requestBody.reasoning] - Reasoning effort config
 * @param {object[]} [requestBody.tools] - Tool definitions
 * @param {object} provider - Provider configuration
 * @param {string} provider.model - Default model override
 * @returns {object} Anthropic Messages request payload
 */
function buildUpstreamRequest(requestBody, provider, _settings) {
  const { messages, systemParts } = convertInputToMessages(requestBody, provider);
  const payload = {
    model: provider.model || requestBody.model,
    messages,
    stream: requestBody.stream !== false,
    max_tokens: requestBody.max_output_tokens || 8192,
  };

  // Merge instructions with system-role messages from input
  const systemTexts = [];
  if (requestBody.instructions) systemTexts.push(requestBody.instructions);
  if (systemParts.length > 0) systemTexts.push(systemParts.join("\n"));
  if (systemTexts.length > 0) {
    payload.system = systemTexts.join("\n\n");
  }

  if (requestBody.temperature !== undefined) {
    payload.temperature = requestBody.temperature;
  }
  if (requestBody.top_p !== undefined) {
    payload.top_p = requestBody.top_p;
  }

  if (requestBody.reasoning && requestBody.reasoning.effort) {
    const effort = requestBody.reasoning.effort;
    if (effort === "xhigh" || effort === "max") {
      payload.thinking = { type: "enabled", budget_tokens: Math.min(payload.max_tokens - 1, 32000) };
    } else {
      const budget = EFFORT_TO_BUDGET[effort];
      if (budget) {
        payload.thinking = { type: "enabled", budget_tokens: budget };
      }
    }
  }

  if (requestBody.tools && requestBody.tools.length > 0) {
    payload.tools = convertTools(requestBody.tools);
  }

  return payload;
}

function convertInputToMessages(requestBody, provider) {
  const messages = [];
  const systemParts = [];
  const input = requestBody.input;
  if (!input) return { messages, systemParts };

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return { messages, systemParts };
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;

      if (item.role) {
        const converted = convertMessageItem(item, provider);
        if (converted.role === "system") {
          systemParts.push(typeof converted.content === "string" ? converted.content : "");
        } else {
          messages.push(converted);
        }
        continue;
      }

      if (item.type === "message") {
        const converted = convertMessageItem(item, provider);
        if (converted.role === "system") {
          systemParts.push(typeof converted.content === "string" ? converted.content : "");
        } else {
          messages.push(converted);
        }
      } else if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: [{
            type: "tool_use",
            id: item.call_id || item.id,
            name: item.name,
            input: safeParseJson(item.arguments),
          }],
        });
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: item.call_id || item.id,
            content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
          }],
        });
      }
    }
  }

  return { messages, systemParts };
}

function convertMessageItem(item, provider) {
  const role = item.role === "assistant" ? "assistant" : (item.role === "system" ? "system" : "user");
  if (typeof item.content === "string") {
    return { role, content: item.content };
  }
  if (Array.isArray(item.content)) {
    const parts = [];
    for (const p of item.content) {
      if (!p) continue;
      if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
        parts.push({ type: "text", text: p.text || "" });
      } else if (p.type === "input_image") {
        if (provider && provider.vision === false) continue;
        const imageUrl = typeof p.image_url === "string" ? p.image_url : (p.image_url && p.image_url.url) || "";
        if (imageUrl && imageUrl.startsWith("data:")) {
          const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
          }
        }
      }
    }
    if (parts.length === 1 && parts[0].type === "text") {
      return { role, content: parts[0].text };
    }
    return { role, content: parts.length > 0 ? parts : "" };
  }
  return { role, content: "" };
}

function convertTools(tools) {
  return tools
    .filter((t) => t && t.type === "function")
    .map((t) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.parameters || t.input_schema || { type: "object", properties: {} },
    }));
}

function safeParseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

/**
 * Stream an Anthropic Messages request and emit Responses API SSE events.
 *
 * Handles Anthropic SSE event sequence: message_start → content_block_start →
 * content_block_delta (thinking/text/input_json/signature) → content_block_stop →
 * message_delta → message_stop. Signature deltas are discarded.
 *
 * Thinking deltas map to reasoningDeltaEvent. Text deltas map to textDeltaEvent.
 * Tool use blocks are tracked by index and emitted as toolCallStartEvent /
 * toolCallArgsDeltaEvent / toolCallEndEvent.
 *
 * If the stream exits without message_stop, emits a stream_interrupted error.
 *
 * @param {object} upstreamPayload - Payload from buildUpstreamRequest
 * @param {object} provider - Provider configuration
 * @param {string} provider.baseUrl - API base URL
 * @param {string} provider.apiKey - API key
 * @param {function} emit - Callback receiving event objects (from events.js factory functions)
 * @returns {Promise<void>}
 */
async function streamUpstream(upstreamPayload, provider, emit) {
  const baseUrl = (provider.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const url = baseUrl + "/v1/messages";

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": provider.apiKey || "",
    "anthropic-version": "2023-06-01",
  };

  const body = Object.assign({}, upstreamPayload);
  delete body.system;
  const requestPayload = upstreamPayload.system
    ? Object.assign({}, body, { system: upstreamPayload.system })
    : body;

  const res = await request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestPayload),
    headersTimeout: 30000,
    bodyTimeout: 120000,
  });

  if (res.statusCode !== 200) {
    const responseBody = await res.body.text();
    let msg = "Upstream returned HTTP " + res.statusCode;
    try {
      const parsed = JSON.parse(responseBody);
      msg = (parsed.error && parsed.error.message) || msg;
    } catch {}

    if (res.statusCode === 400 && msg.includes("signature")) {
      emit(errorEvent("Anthropic signature error — retrying without signatures is not yet supported. " + msg, "signature_error"));
    } else {
      emit(errorEvent(msg, "upstream_" + res.statusCode));
    }
    return;
  }

  let usage = null;
  const toolCalls = {};
  let _currentBlockType = null;
  let currentBlockIndex = -1;
  let streamEndedCleanly = false;

  for await (const chunk of parseSSEStream(res.body)) {
    let data;
    try { data = JSON.parse(chunk); } catch { console.warn("[anthropic] unparseable SSE chunk"); continue; }

    const eventType = data.type;

    if (eventType === "message_start") {
      if (data.message && data.message.usage) {
        usage = { input_tokens: data.message.usage.input_tokens || 0, output_tokens: 0, total_tokens: 0 };
      }
      continue;
    }

    if (eventType === "message_delta") {
      if (data.usage) {
        const outTokens = data.usage.output_tokens || 0;
        if (usage) {
          usage.output_tokens = outTokens;
          usage.total_tokens = usage.input_tokens + outTokens;
        }
      }
      continue;
    }

    if (eventType === "content_block_start") {
      currentBlockIndex = data.index !== undefined ? data.index : currentBlockIndex + 1;
      const block = data.content_block;
      if (!block) continue;
      _currentBlockType = block.type;
      if (block.type === "tool_use") {
        const callId = block.id || "call_" + currentBlockIndex;
        toolCalls[currentBlockIndex] = { id: callId, name: block.name || "", args: "" };
        emit(toolCallStartEvent(callId, block.name || ""));
      }
      continue;
    }

    if (eventType === "content_block_delta") {
      const delta = data.delta;
      if (!delta) continue;

      if (delta.type === "thinking_delta") {
        emit(reasoningDeltaEvent(delta.thinking || ""));
      } else if (delta.type === "text_delta") {
        emit(textDeltaEvent(delta.text || ""));
      } else if (delta.type === "input_json_delta") {
        const tc = toolCalls[currentBlockIndex];
        if (tc) {
          tc.args += delta.partial_json || "";
          emit(toolCallArgsDeltaEvent(tc.id, delta.partial_json || ""));
        }
      } else if (delta.type === "signature_delta") {
        // Discard signature deltas
      }
      continue;
    }

    if (eventType === "content_block_stop") {
      const tc = toolCalls[currentBlockIndex];
      if (tc && tc.name) {
        emit(toolCallEndEvent(tc.id, tc.name, tc.args));
      }
      _currentBlockType = null;
      continue;
    }

    if (eventType === "message_stop") {
      streamEndedCleanly = true;
      break;
    }
  }

  if (!streamEndedCleanly) {
    emit(errorEvent("Upstream stream ended unexpectedly", "stream_interrupted"));
    return;
  }

  emit(responseCompletedEvent(usage));
}

/**
 * Make a non-streaming Anthropic Messages request.
 *
 * Returns a structured result with text, reasoning, toolCalls, and usage fields.
 * Text and thinking content blocks are concatenated. Tool use blocks become
 * toolCalls entries with JSON-stringified arguments.
 *
 * On error, throws an Error with a `statusCode` property set to the HTTP status.
 *
 * @param {object} upstreamPayload - Payload from buildUpstreamRequest
 * @param {object} provider - Provider configuration
 * @returns {Promise<{text: string, reasoning: string, toolCalls: Array, usage: object|null}>}
 */
async function callUpstream(upstreamPayload, provider) {
  const payload = Object.assign({}, upstreamPayload, { stream: false });
  const baseUrl = (provider.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const url = baseUrl + "/v1/messages";

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": provider.apiKey || "",
    "anthropic-version": "2023-06-01",
  };

  const res = await request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    headersTimeout: 30000,
    bodyTimeout: 120000,
  });

  const responseBody = await res.body.text();
  if (res.statusCode !== 200) {
    let msg = "Upstream returned HTTP " + res.statusCode;
    try { msg = JSON.parse(responseBody).error.message || msg; } catch {}
    const err = new Error(msg);
    err.statusCode = res.statusCode;
    throw err;
  }

  const data = JSON.parse(responseBody);
  const result = { text: "", reasoning: "", toolCalls: [], usage: null };

  if (data.usage) {
    result.usage = {
      input_tokens: data.usage.input_tokens || 0,
      output_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    };
  }

  if (data.content && Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === "thinking") {
        result.reasoning += block.thinking || "";
      } else if (block.type === "text") {
        result.text += block.text || "";
      } else if (block.type === "tool_use") {
        result.toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        });
      }
    }
  }

  return result;
}


module.exports = {
  buildUpstreamRequest,
  streamUpstream,
  callUpstream,
};
