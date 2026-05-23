"use strict";

const { request } = require("undici");
const log = require("../../shared/logger");
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

// ---------------------------------------------------------------------------
// Thinking tag stream parser
// ---------------------------------------------------------------------------
// Detects <thinking>, <think>, <thought>, <reasoning> tags inside streaming
// text content and splits deltas into reasoning (inside tags) vs. text
// (outside). Needed for GLM and other providers that inline thinking in the
// content field rather than using a separate reasoning_content field.
//
// Tags are case-insensitive.  Unclosed tags at stream-end are flushed as
// regular text so nothing is lost.

const THINKING_OPEN_RE = /<\s*(think(?:ing)?|thought|reasoning)\s*>/i;

// Normalize tag family: think/thinking → thinking, thought → reasoning
function normalizeTagName(name) {
  const n = name.toLowerCase();
  if (n === "think") return "thinking";
  if (n === "thought") return "reasoning";
  return n;
}

// Return all closing-tag strings that could close a given normalized tag.
// "thinking" can be closed by </thinking> or </think>.
// "reasoning" can be closed by </reasoning> or </thought>.
function closeTagVariants(normalized) {
  if (normalized === "thinking") return ["</thinking>", "</think>"];
  if (normalized === "reasoning") return ["</reasoning>", "</thought>"];
  return ["</" + normalized + ">"];
}

// Find the earliest close-tag match among the variants, returning
// { index, length } or null.  Case-insensitive.
function findCloseTag(buf, normalized) {
  const variants = closeTagVariants(normalized);
  let best = null;
  for (const v of variants) {
    const idx = buf.toLowerCase().indexOf(v.toLowerCase());
    if (idx >= 0 && (best === null || idx < best.index)) {
      best = { index: idx, length: v.length };
    }
  }
  return best;
}

// Check if the tail of `buf` is a prefix of any close-tag variant.  Returns
// the number of chars to keep (the length of the longest matching prefix).
// This prevents closing tags split across SSE chunks from leaking.
function maybePartialCloseTag(buf, normalized) {
  if (buf.length === 0) return 0;
  const variants = closeTagVariants(normalized);
  const lower = buf.toLowerCase();
  for (const v of variants) {
    const lowerV = v.toLowerCase();
    // Check every suffix of buf that could be a prefix of this variant
    for (let keep = 1; keep <= Math.min(buf.length, lowerV.length - 1); keep++) {
      const suffix = lower.slice(-keep);
      if (lowerV.startsWith(suffix)) return keep;
    }
  }
  return 0;
}

class ThinkingTagStreamParser {
  constructor() {
    this._buf = "";
    this._inTag = false;
    this._tagName = "";
  }

  feed(chunk) {
    this._buf += chunk;
    let reasoning = "";
    let text = "";

    while (this._buf.length > 0) {
      if (!this._inTag) {
        const m = this._buf.match(THINKING_OPEN_RE);
        if (!m) {
          // Keep a look-behind window for a partial opening tag.
          const lt = this._buf.lastIndexOf("<");
          if (lt >= 0 && this._buf.length - lt <= 20) {
            text += this._buf.slice(0, lt);
            this._buf = this._buf.slice(lt);
            break;
          }
          text += this._buf;
          this._buf = "";
          break;
        }
        text += this._buf.slice(0, m.index);
        this._buf = this._buf.slice(m.index + m[0].length);
        this._inTag = true;
        this._tagName = normalizeTagName(m[1]);
      } else {
        const found = findCloseTag(this._buf, this._tagName);
        if (!found) {
          const keep = maybePartialCloseTag(this._buf, this._tagName);
          if (keep > 0) {
            reasoning += this._buf.slice(0, -keep);
            this._buf = this._buf.slice(-keep);
            break;
          }
          reasoning += this._buf;
          this._buf = "";
          break;
        }
        reasoning += this._buf.slice(0, found.index);
        this._buf = this._buf.slice(found.index + found.length);
        this._inTag = false;
        this._tagName = "";
      }
    }

    return { reasoning, text };
  }

  flush() {
    if (this._inTag) {
      const result = { reasoning: "", text: "<" + this._tagName + ">" + this._buf };
      this._buf = "";
      this._inTag = false;
      this._tagName = "";
      return result;
    }
    const result = { reasoning: "", text: this._buf };
    this._buf = "";
    return result;
  }
}

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

  // DeepSeek user_id for account-level isolation (KVCache / safety / scheduling)
  if (provider.userId) {
    payload.user_id = provider.userId;
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
 * @param {object} [traceSession] - Optional trace session for raw SSE capture
 * @returns {Promise<void>}
 */
async function streamUpstream(upstreamPayload, provider, emit, traceSession) {
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
  const thinkParser = new ThinkingTagStreamParser();

  for await (const chunk of parseSSEStream(res.body)) {
    if (traceSession) traceSession.logRawLine(chunk);
    if (chunk === "[DONE]") { streamEndedCleanly = true; break; }

    let data;
    try { data = JSON.parse(chunk); } catch { log.warn("[openai-chat] unparseable SSE chunk"); continue; }

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

    // Reasoning content (DeepSeek, o-series, Kimi, etc.)
    if (delta.reasoning_content) {
      emit(reasoningDeltaEvent(delta.reasoning_content));
    }

    // Text content — run through thinking-tag parser so providers that inline
    // <thinking>…</thinking> inside `content` (GLM, etc.) get their reasoning
    // split out into proper reasoning events.
    if (delta.content) {
      const parsed = thinkParser.feed(delta.content);
      if (parsed.reasoning) emit(reasoningDeltaEvent(parsed.reasoning));
      if (parsed.text) emit(textDeltaEvent(parsed.text));
    }

    // Tool calls — standard OpenAI array format
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

    // Fallback: older single function_call format (some Chinese LLMs)
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

  // Flush any remaining content buffered in the thinking tag parser
  const flushed = thinkParser.flush();
  if (flushed.reasoning) emit(reasoningDeltaEvent(flushed.reasoning));
  if (flushed.text) emit(textDeltaEvent(flushed.text));

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
 * @param {object} [traceSession] - Optional trace session for raw response capture
 * @returns {Promise<{text: string, reasoning: string, toolCalls: Array, usage: object|null}>}
 */
async function callUpstream(upstreamPayload, provider, traceSession) {
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
  if (traceSession) traceSession.logRawLine(body);
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
    // reasoning_content field (DeepSeek, o-series, Kimi)
    result.reasoning = message.reasoning_content || "";

    // Strip inline thinking tags from content and promote to reasoning
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
    // Fallback: older single function_call format
    if (result.toolCalls.length === 0 && message.function_call) {
      result.toolCalls = [{
        id: message.function_call.id || "call_0",
        name: message.function_call.name || "",
        arguments: message.function_call.arguments || "{}",
      }];
    }
  }

  return result;
}

/**
 * Strip inline <thinking>, <think>, <thought>, <reasoning> tags from text
 * and return the extracted reasoning separately.  Used in the non-streaming
 * path where the full response text is available.
 */
function extractThinkingTags(text) {
  const reasoning = [];
  const cleaned = text.replace(
    /<\s*(think(?:ing)?|thought|reasoning)\s*>([\s\S]*?)<\/\s*\1\s*>/gi,
    function (_match, _tag, inner) {
      if (inner.trim()) reasoning.push(inner.trim());
      return "";
    }
  );
  return { text: cleaned.trim(), reasoning: reasoning.join("\n\n") };
}

module.exports = {
  buildUpstreamRequest,
  streamUpstream,
  callUpstream,
};
