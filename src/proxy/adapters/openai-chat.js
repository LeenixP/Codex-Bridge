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

/**
 * Build an OpenAI Chat Completions request from a Codex Responses API request body.
 *
 * Converts Responses-format input into Chat Completions messages, mapping:
 *   instructions → system role message
 *   max_output_tokens → max_completion_tokens
 *   reasoning.effort → reasoning_effort
 *   text.format → response_format (json_object / json_schema)
 *   tools (function type) → tools array with function definitions
 *   input_image content parts → image_url parts
 *
 * @param {object} requestBody - Codex Responses API request body
 * @param {string} requestBody.model - Model ID
 * @param {string|Array} requestBody.input - User input (string or content array)
 * @param {string} [requestBody.instructions] - System instructions
 * @param {boolean} [requestBody.stream=true] - Whether to stream
 * @param {number} [requestBody.max_output_tokens] - Max completion tokens
 * @param {number} [requestBody.temperature] - Sampling temperature
 * @param {number} [requestBody.top_p] - Nucleus sampling parameter
 * @param {object} [requestBody.reasoning] - Reasoning effort config
 * @param {object} [requestBody.text] - Text format config
 * @param {object[]} [requestBody.tools] - Tool definitions
 * @param {object} provider - Provider configuration
 * @param {string} provider.model - Default model override
 * @returns {object} OpenAI Chat Completions request payload
 */
function buildUpstreamRequest(requestBody, provider, _settings) {
  const messages = convertInputToMessages(requestBody, provider);
  const payload = {
    model: provider.model || requestBody.model,
    messages,
    stream: requestBody.stream !== false,
  };

  if (requestBody.max_output_tokens) {
    payload.max_completion_tokens = requestBody.max_output_tokens;
  }
  if (requestBody.temperature !== undefined) {
    payload.temperature = requestBody.temperature;
  }
  if (requestBody.top_p !== undefined) {
    payload.top_p = requestBody.top_p;
  }
  if (requestBody.reasoning && requestBody.reasoning.effort) {
    payload.reasoning_effort = requestBody.reasoning.effort;
  }
  if (requestBody.text && requestBody.text.format) {
    payload.response_format = convertResponseFormat(requestBody.text.format);
  }
  if (requestBody.tools && requestBody.tools.length > 0) {
    payload.tools = convertTools(requestBody.tools);
  }

  return payload;
}

function convertInputToMessages(requestBody, provider) {
  const messages = [];

  if (requestBody.instructions) {
    messages.push({ role: "system", content: requestBody.instructions });
  }

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
        messages.push(convertMessageItem(item, provider));
        continue;
      }

      if (item.type === "message") {
        messages.push(convertMessageItem(item, provider));
      } else if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          tool_calls: [{
            id: item.call_id || item.id,
            type: "function",
            function: { name: item.name, arguments: item.arguments || "{}" },
          }],
        });
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        });
      }
    }
  }

  return messages;
}

function convertMessageItem(item, provider) {
  const role = item.role || "user";
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
        if (imageUrl) {
          parts.push({ type: "image_url", image_url: { url: imageUrl, detail: p.detail || "auto" } });
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

function convertResponseFormat(format) {
  if (!format) return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: format.name || "response",
        strict: format.strict !== false,
        schema: format.schema || {},
      },
    };
  }
  return undefined;
}

function convertTools(tools) {
  return tools
    .filter((t) => t && t.type === "function")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || t.input_schema || {},
      },
    }));
}

/**
 * Stream an OpenAI Chat Completions request and emit Responses API SSE events.
 *
 * Parses SSE chunks from the upstream, tracking tool call state across deltas.
 * Emits: reasoningDeltaEvent, textDeltaEvent, toolCallStartEvent,
 *        toolCallArgsDeltaEvent, toolCallEndEvent, responseCompletedEvent, errorEvent.
 *
 * If the stream ends without [DONE], emits a stream_interrupted error.
 *
 * @param {object} upstreamPayload - Payload from buildUpstreamRequest
 * @param {object} provider - Provider configuration
 * @param {string} provider.baseUrl - API base URL
 * @param {string} provider.apiKey - API key
 * @param {function} emit - Callback receiving event objects (from events.js factory functions)
 * @returns {Promise<void>}
 */
async function streamUpstream(upstreamPayload, provider, emit) {
  const baseUrl = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = baseUrl + "/chat/completions";

  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + (provider.apiKey || ""),
  };

  const res = await request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamPayload),
    headersTimeout: 30000,
    bodyTimeout: 120000,
  });

  if (res.statusCode !== 200) {
    const body = await res.body.text();
    let msg = "Upstream returned HTTP " + res.statusCode;
    try { msg = JSON.parse(body).error.message || msg; } catch {}
    emit(errorEvent(msg, "upstream_" + res.statusCode));
    return;
  }

  const toolCalls = {};
  let usage = null;
  let streamEndedCleanly = false;

  for await (const chunk of parseSSEStream(res.body)) {
    if (chunk === "[DONE]") { streamEndedCleanly = true; break; }

    let data;
    try { data = JSON.parse(chunk); } catch { console.warn("[openai-chat] unparseable SSE chunk"); continue; }

    if (data.usage) {
      usage = {
        input_tokens: data.usage.prompt_tokens || 0,
        output_tokens: data.usage.completion_tokens || 0,
        total_tokens: data.usage.total_tokens || 0,
      };
    }

    const choice = data.choices && data.choices[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (!delta) continue;

    // Reasoning content (DeepSeek, o-series)
    if (delta.reasoning_content) {
      emit(reasoningDeltaEvent(delta.reasoning_content));
    }

    // Text content
    if (delta.content) {
      emit(textDeltaEvent(delta.content));
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index !== undefined ? tc.index : 0;
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: tc.id || "", name: "", args: "" };
        }
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function && tc.function.name) {
          toolCalls[idx].name = tc.function.name;
          emit(toolCallStartEvent(toolCalls[idx].id, toolCalls[idx].name));
        }
        if (tc.function && tc.function.arguments) {
          toolCalls[idx].args += tc.function.arguments;
          emit(toolCallArgsDeltaEvent(toolCalls[idx].id, tc.function.arguments));
        }
      }
    }

    // Finish
    if (choice.finish_reason) {
      streamEndedCleanly = true;
      for (const [, tc] of Object.entries(toolCalls)) {
        if (tc.name) {
          emit(toolCallEndEvent(tc.id, tc.name, tc.args));
        }
      }
    }
  }

  if (!streamEndedCleanly) {
    emit(errorEvent("Upstream stream ended unexpectedly", "stream_interrupted"));
    return;
  }

  emit(responseCompletedEvent(usage));
}

/**
 * Make a non-streaming OpenAI Chat Completions request.
 *
 * Returns a structured result with text, reasoning, toolCalls, and usage fields.
 * On error, throws an Error with a `statusCode` property set to the HTTP status.
 *
 * @param {object} upstreamPayload - Payload from buildUpstreamRequest
 * @param {object} provider - Provider configuration
 * @returns {Promise<{text: string, reasoning: string, toolCalls: Array, usage: object|null}>}
 */
async function callUpstream(upstreamPayload, provider) {
  const payload = Object.assign({}, upstreamPayload, { stream: false });
  const baseUrl = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = baseUrl + "/chat/completions";

  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + (provider.apiKey || ""),
  };

  const res = await request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    headersTimeout: 30000,
    bodyTimeout: 120000,
  });

  const body = await res.body.text();
  if (res.statusCode !== 200) {
    let msg = "Upstream returned HTTP " + res.statusCode;
    try { msg = JSON.parse(body).error.message || msg; } catch {}
    const err = new Error(msg);
    err.statusCode = res.statusCode;
    throw err;
  }

  const data = JSON.parse(body);
  const choice = data.choices && data.choices[0];
  const message = choice && choice.message;

  const result = { text: "", reasoning: "", toolCalls: [], usage: null };

  if (data.usage) {
    result.usage = {
      input_tokens: data.usage.prompt_tokens || 0,
      output_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    };
  }

  if (message) {
    result.text = message.content || "";
    result.reasoning = message.reasoning_content || "";
    if (message.tool_calls) {
      result.toolCalls = message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments || "{}",
      }));
    }
  }

  return result;
}


module.exports = {
  buildUpstreamRequest,
  streamUpstream,
  callUpstream,
};
