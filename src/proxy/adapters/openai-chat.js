"use strict";

const { request } = require("undici");
const log = require("../../shared/logger");
const { parseSSEStream } = require("../../shared/stream");
const { stripCodexFields } = require("../../shared/request-cleaner");
const { ThinkingTagStreamParser, extractThinkingTags } = require("../../shared/thinking-parser");
const { getHooks } = require("../presets");
const {
  reasoningDeltaEvent,
  textDeltaEvent,
  toolCallStartEvent,
  toolCallArgsDeltaEvent,
  toolCallEndEvent,
  responseCompletedEvent,
  errorEvent,
} = require("../core/events");

function buildUpstreamRequest(requestBody, provider, _settings) {
  if (typeof requestBody.input === "string") {
    if (requestBody.input.trim()) {
      requestBody.input = [{ role: "user", content: requestBody.input }];
    } else {
      requestBody.input = [];
    }
  }
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
    payload.reasoning_effort = normalizeReasoningEffort(requestBody.reasoning.effort);
    payload._reasoning_effort = requestBody.reasoning.effort;
  }
  if (requestBody.text && requestBody.text.format) {
    payload.response_format = convertResponseFormat(requestBody.text.format);
  }
  if (requestBody.tools && requestBody.tools.length > 0) {
    payload.tools = convertTools(requestBody.tools);
    if (payload.tools.length === 0) delete payload.tools;
  }
  if (requestBody.tool_choice) {
    payload.tool_choice = convertToolChoice(requestBody.tool_choice);
  }
  if (requestBody.parallel_tool_calls !== undefined) {
    payload.parallel_tool_calls = requestBody.parallel_tool_calls;
  }
  if (provider.userId) {
    payload.user_id = provider.userId;
  }

  stripCodexFields(payload);

  return payload;
}

function normalizeReasoningEffort(effort) {
  if (effort === "max") return "high";
  if (effort === "xhigh") return "high";
  return effort;
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
    let pendingReasoning = "";

    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;

      if (item.role) {
        const msg = convertMessageItem(item, provider);
        if (pendingReasoning && msg.role === "assistant") {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = "";
        }

        // Merge consecutive system messages — OpenAI Chat API only
        // allows at most one system message.  Codex sends instructions as
        // a top-level field AND embeds instructions in a developer-role
        // input item, so we get two system messages after mapping.
        if (msg.role === "system" && messages.length > 0 && messages[messages.length - 1].role === "system") {
          var prev = messages[messages.length - 1];
          var prevContent = typeof prev.content === "string" ? prev.content : "";
          var newContent = typeof msg.content === "string" ? msg.content : "";
          prev.content = prevContent + "\n\n" + newContent;
        } else {
          messages.push(msg);
        }
        continue;
      }

      if (item.type === "message") {
        const msg = convertMessageItem(item, provider);
        if (pendingReasoning && msg.role === "assistant") {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = "";
        }
        messages.push(msg);
      } else if (item.type === "reasoning") {
        const summaries = Array.isArray(item.summary) ? item.summary : item.summary ? [item.summary] : [];
        const texts = summaries.filter((s) => s && s.type === "summary_text" && s.text).map((s) => s.text);
        if (texts.length > 0) {
          pendingReasoning = (pendingReasoning ? pendingReasoning + "\n" : "") + texts.join("\n");
        }
      } else if (item.type === "function_call") {
        const tc = {
          role: "assistant",
          tool_calls: [
            {
              id: item.call_id || item.id,
              type: "function",
              function: { name: item.name, arguments: item.arguments || "{}" },
            },
          ],
        };
        if (pendingReasoning) {
          tc.reasoning_content = pendingReasoning;
          pendingReasoning = "";
        }
        messages.push(tc);
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        });
      } else if (item.type === "web_search_call") {
        messages.push({
          role: "assistant",
          tool_calls: [{
            id: item.call_id || "ws_" + Math.random().toString(36).slice(2, 10),
            type: "function",
            function: {
              name: "web_search",
              arguments: JSON.stringify(item.action || {}),
            },
          }],
        });
      } else if (item.type === "web_search_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""),
        });
      } else if (item.type === "custom_tool_call") {
        messages.push({
          role: "assistant",
          tool_calls: [{
            id: item.call_id || "ct_" + Math.random().toString(36).slice(2, 10),
            type: "function",
            function: {
              name: item.name || "custom_tool",
              arguments: typeof item.input === "string" ? item.input : JSON.stringify(item.input || {}),
            },
          }],
        });
      } else if (item.type === "custom_tool_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""),
        });
      } else if (item.type === "compaction" || item.type === "compaction_trigger") {
        continue;
      }
    }

    if (pendingReasoning) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          messages[i].reasoning_content =
            (messages[i].reasoning_content || "") + (messages[i].reasoning_content ? "\n" : "") + pendingReasoning;
          pendingReasoning = "";
          break;
        }
      }
      if (pendingReasoning) {
        messages.push({ role: "assistant", content: "", reasoning_content: pendingReasoning });
      }
    }
  }

  return messages;
}

function convertMessageItem(item, provider) {
  // Map developer role to system — OpenAI Chat API only accepts
  // system/user/assistant/tool roles. developer is a Responses
  // API concept that some providers reject.
  var rawRole = item.role || "user";
  var role = rawRole === "developer" ? "system" : rawRole;
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
    if (parts.length === 0) return { role, content: "" };
    if (parts.length === 1 && parts[0].type === "text") {
      return { role, content: parts[0].text };
    }
    // System messages must use string content per OpenAI Chat API.
    // Join multiple text parts so composite instructions work correctly.
    if (role === "system") {
      var joined = parts
        .filter(function (p) { return p.type === "text"; })
        .map(function (p) { return p.text; })
        .join("\n\n");
      return { role: "system", content: joined || "" };
    }
    return { role, content: parts };
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
  return tools.flatMap((t) => {
    if (!t) return [];
    if (t.type === "function" || t.type === "custom") {
      return [{
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.parameters || t.input_schema || {},
        },
      }];
    }
    if (t.type === "namespace" && Array.isArray(t.tools)) {
      return t.tools
        .filter((sub) => sub && (sub.type === "function" || sub.type === "custom"))
        .map((sub) => ({
          type: "function",
          function: {
            name: t.name + "__" + sub.name,
            description: sub.description || "",
            parameters: sub.parameters || sub.input_schema || {},
          },
        }));
    }
    return [];
  });
}

async function streamUpstream(upstreamPayload, provider, emit, traceSession) {
  const baseUrl = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = baseUrl + "/chat/completions";

  const hooks = getHooks(provider);
  const extraHeaders = hooks && hooks.getHeaders ? hooks.getHeaders(provider) : {};

  const headers = Object.assign(
    {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (provider.apiKey || ""),
    },
    extraHeaders,
  );

  const res = await request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamPayload),
    headersTimeout: 30000,
    bodyTimeout: 120000,
  });

  if (res.statusCode !== 200) {
    const errorBody = await res.body.text();
    let msg = "Upstream returned HTTP " + res.statusCode;
    try {
      const parsed = JSON.parse(errorBody);
      msg = (parsed.error && parsed.error.message) || msg;
    } catch {}
    if (traceSession) traceSession.logRawLine("[ERROR] " + res.statusCode + " " + msg);
    emit(errorEvent(msg, "upstream_" + res.statusCode));
    return;
  }

  const toolCalls = {};
  let usage = null;
  let streamEndedCleanly = false;
  const thinkParser = new ThinkingTagStreamParser();

  for await (const chunk of parseSSEStream(res.body)) {
    if (traceSession) traceSession.logRawLine(chunk);
    if (chunk === "[DONE]") {
      streamEndedCleanly = true;
      break;
    }

    let data;
    try {
      data = JSON.parse(chunk);
    } catch {
      log.warn("[openai-chat] unparseable SSE chunk");
      continue;
    }

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

    if (delta.reasoning_content) {
      emit(reasoningDeltaEvent(delta.reasoning_content));
    }

    if (delta.content) {
      const parsed = thinkParser.feed(delta.content);
      if (parsed.reasoning) emit(reasoningDeltaEvent(parsed.reasoning));
      if (parsed.text) emit(textDeltaEvent(parsed.text));
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index !== undefined ? tc.index : 0;
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: tc.id || "", name: "", args: "", started: false };
        }
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function && tc.function.name) {
          toolCalls[idx].name = tc.function.name;
          if (!toolCalls[idx].started) {
            toolCalls[idx].started = true;
            emit(toolCallStartEvent(toolCalls[idx].id, toolCalls[idx].name));
          }
        }
        if (tc.function && tc.function.arguments) {
          toolCalls[idx].args += tc.function.arguments;
          emit(toolCallArgsDeltaEvent(toolCalls[idx].id, tc.function.arguments));
        }
      }
    }

    if (!delta.tool_calls && delta.function_call) {
      const fc = delta.function_call;
      const idx = 0;
      if (!toolCalls[idx]) {
        toolCalls[idx] = { id: fc.id || "call_0", name: "", args: "", started: false };
      }
      if (fc.id) toolCalls[idx].id = fc.id;
      if (fc.name) {
        toolCalls[idx].name = fc.name;
        if (!toolCalls[idx].started) {
          toolCalls[idx].started = true;
          emit(toolCallStartEvent(toolCalls[idx].id, toolCalls[idx].name));
        }
      }
      if (fc.arguments) {
        toolCalls[idx].args += fc.arguments;
        emit(toolCallArgsDeltaEvent(toolCalls[idx].id, fc.arguments));
      }
    }

    if (choice.finish_reason) {
      streamEndedCleanly = true;
      for (const [, tc] of Object.entries(toolCalls)) {
        if (tc.name) {
          emit(toolCallEndEvent(tc.id, tc.name, tc.args));
        }
      }
    }
  }

  const flushed = thinkParser.flush();
  if (flushed.reasoning) emit(reasoningDeltaEvent(flushed.reasoning));
  if (flushed.text) emit(textDeltaEvent(flushed.text));

  if (!streamEndedCleanly) {
    emit(errorEvent("Upstream stream ended unexpectedly", "stream_interrupted"));
    return;
  }

  emit(responseCompletedEvent(usage));
}

async function callUpstream(upstreamPayload, provider, traceSession) {
  const payload = Object.assign({}, upstreamPayload, { stream: false });
  const baseUrl = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = baseUrl + "/chat/completions";

  const hooks2 = getHooks(provider);
  const extraHeaders2 = hooks2 && hooks2.getHeaders ? hooks2.getHeaders(provider) : {};

  const headers = Object.assign(
    {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (provider.apiKey || ""),
    },
    extraHeaders2,
  );

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
    try {
      msg = JSON.parse(body).error.message || msg;
    } catch {}
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
    result.reasoning = message.reasoning_content || "";

    const extracted = extractThinkingTags(message.content || "");
    result.text = extracted.text;
    if (extracted.reasoning) {
      result.reasoning = result.reasoning ? result.reasoning + "\n\n" + extracted.reasoning : extracted.reasoning;
    }

    if (message.tool_calls) {
      result.toolCalls = message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments || "{}",
      }));
    }
    if (result.toolCalls.length === 0 && message.function_call) {
      result.toolCalls = [
        {
          id: message.function_call.id || "call_0",
          name: message.function_call.name || "",
          arguments: message.function_call.arguments || "{}",
        },
      ];
    }
  }

  return result;
}

function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  if (toolChoice.type === "function") {
    const name = toolChoice.function && toolChoice.function.name;
    return name ? { type: "function", function: { name } } : "auto";
  }
  if (toolChoice.type === "allowed_tools") {
    const tools = Array.isArray(toolChoice.tools) && toolChoice.tools.length > 0 ? toolChoice.tools : [];
    if (tools.length > 0) {
      return { type: "function", function: { name: tools[0] } };
    }
    return "auto";
  }
  return "auto";
}

module.exports = {
  buildUpstreamRequest,
  streamUpstream,
  callUpstream,
};
