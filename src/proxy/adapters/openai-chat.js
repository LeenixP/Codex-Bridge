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

function buildUpstreamRequest(requestBody, provider, settings) {
  const messages = convertInputToMessages(requestBody);
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

function convertInputToMessages(requestBody) {
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
        messages.push(convertMessageItem(item));
        continue;
      }

      if (item.type === "message") {
        messages.push(convertMessageItem(item));
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

function convertMessageItem(item) {
  const role = item.role || "user";
  if (typeof item.content === "string") {
    return { role, content: item.content };
  }
  if (Array.isArray(item.content)) {
    const textParts = item.content
      .filter((p) => p && (p.type === "input_text" || p.type === "output_text" || p.type === "text"))
      .map((p) => p.text || "");
    return { role, content: textParts.join("") };
  }
  return { role, content: "" };
}

function convertResponseFormat(format) {
  if (!format) return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    return { type: "json_schema", json_schema: format.json_schema || format.schema };
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
  let hasReasoning = false;

  for await (const chunk of parseSSEStream(res.body)) {
    if (chunk === "[DONE]") break;

    let data;
    try { data = JSON.parse(chunk); } catch { continue; }

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
      hasReasoning = true;
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
      for (const [, tc] of Object.entries(toolCalls)) {
        if (tc.name) {
          emit(toolCallEndEvent(tc.id, tc.name, tc.args));
        }
      }
    }
  }

  emit(responseCompletedEvent(usage));
}

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
    throw new Error(msg);
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
