"use strict";

const { request } = require("undici");
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

function buildUpstreamRequest(requestBody, provider, settings) {
  const messages = convertInputToMessages(requestBody);
  const payload = {
    model: provider.model || requestBody.model,
    messages,
    stream: requestBody.stream !== false,
    max_tokens: requestBody.max_output_tokens || 8192,
  };

  if (requestBody.instructions) {
    payload.system = requestBody.instructions;
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
      payload.thinking = { type: "enabled", budget_tokens: Math.max(payload.max_tokens - 1, 10000) };
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

function convertInputToMessages(requestBody) {
  const messages = [];
  const input = requestBody.input;
  if (!input) return messages;

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;

      if (item.role) {
        messages.push(convertMessageItem(item));
        continue;
      }

      if (item.type === "message") {
        messages.push(convertMessageItem(item));
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

  return messages;
}

function convertMessageItem(item) {
  const role = item.role === "assistant" ? "assistant" : "user";
  if (typeof item.content === "string") {
    return { role, content: item.content };
  }
  if (Array.isArray(item.content)) {
    const parts = [];
    for (const p of item.content) {
      if (!p) continue;
      if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
        parts.push({ type: "text", text: p.text || "" });
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
  let currentBlockType = null;
  let currentBlockIndex = -1;

  for await (const chunk of parseSSEStream(res.body)) {
    let data;
    try { data = JSON.parse(chunk); } catch { continue; }

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
      currentBlockType = block.type;
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
      currentBlockType = null;
      continue;
    }

    if (eventType === "message_stop") {
      break;
    }
  }

  emit(responseCompletedEvent(usage));
}

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
    throw new Error(msg);
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

async function* parseSSEStream(body) {
  let buffer = "";
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("data: ")) {
        const payload = trimmed.slice(6).trim();
        if (payload) yield payload;
      }
    }
  }
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ")) {
      yield trimmed.slice(6).trim();
    }
  }
}

module.exports = {
  buildUpstreamRequest,
  streamUpstream,
  callUpstream,
};
