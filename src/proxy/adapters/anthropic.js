"use strict";

const { request } = require("undici");
const log = require("../../shared/logger");
const { parseSSEStream } = require("../../shared/stream");
const reasoningCache = require("../core/reasoning-cache");
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
  responseIncompleteEvent,
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
 *   instructions + system-role messages �?top-level system field
 *   reasoning.effort �?thinking budget_tokens (low=2000, medium=8000, high=16000, xhigh/max=32000)
 *   tools (function type) �?Anthropic tool definitions with input_schema
 *   function_call �?assistant tool_use content block
 *   function_call_output �?user tool_result content block
 *   input_image content parts �?Anthropic image source (requires base64 data URI)
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
    _betas: [],
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
      payload._betas.push("thinking-2025");
    } else {
      const budget = EFFORT_TO_BUDGET[effort];
      if (budget) {
        payload.thinking = { type: "enabled", budget_tokens: budget };
        payload._betas.push("thinking-2025");
      }
    }
  }

  if (requestBody.tools && requestBody.tools.length > 0) {
    payload.tools = convertTools(requestBody.tools);
    if (payload.tools.length === 0) delete payload.tools;
    // Add computer-use beta header when computer tools are present
    if (
      payload.tools &&
      payload.tools.some(function (t) {
        return t.type === "computer_20250124";
      })
    ) {
      payload._betas.push("computer-use-2025-01-24");
    }
  }
  if (requestBody.tool_choice) {
    payload.tool_choice = convertToolChoice(requestBody.tool_choice);
  }
  if (requestBody.parallel_tool_calls !== undefined) {
    payload.disable_parallel_tool_use = !requestBody.parallel_tool_calls;
  }

  // DeepSeek user_id via Anthropic metadata (account-level isolation)
  if (provider.userId) {
    payload.metadata = { user_id: provider.userId };
  }

  stripCodexFields(payload);

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
    // Collect reasoning summaries and inject them into the following
    // assistant message. Vendor hooks (DeepSeek) upgrade these with
    // signature-aware blocks later.
    let pendingBlocks = [];

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
          if (pendingBlocks.length > 0 && converted.role === "assistant") {
            prependThinkingBlocks(converted, pendingBlocks);
            pendingBlocks = [];
          }
          messages.push(converted);
        }
        continue;
      }

      if (item.type === "message") {
        const converted = convertMessageItem(item, provider);
        if (converted.role === "system") {
          systemParts.push(typeof converted.content === "string" ? converted.content : "");
        } else {
          if (pendingBlocks.length > 0 && converted.role === "assistant") {
            prependThinkingBlocks(converted, pendingBlocks);
            pendingBlocks = [];
          }
          messages.push(converted);
        }
      } else if (item.type === "reasoning") {
        const summaries = Array.isArray(item.summary) ? item.summary : item.summary ? [item.summary] : [];
        for (const s of summaries) {
          if (!s || s.type !== "summary_text" || !s.text) continue;
          const sig = reasoningCache.get(s.text);
          const block = { type: "thinking", thinking: s.text };
          if (sig) block.signature = sig;
          pendingBlocks.push(block);
        }
      } else if (item.type === "function_call") {
        const toolUse = {
          type: "tool_use",
          id: item.call_id || item.id,
          name: item.name,
          input: safeParseJson(item.arguments),
        };
        // Merge into previous message if it's an assistant (keeps tool_use together)
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          if (typeof last.content === "string") {
            last.content = [{ type: "text", text: last.content }, toolUse];
          } else if (Array.isArray(last.content)) {
            last.content.push(toolUse);
          } else {
            last.content = [toolUse];
          }
        } else {
          const newMsg = { role: "assistant", content: [toolUse] };
          if (pendingBlocks.length > 0) {
            prependThinkingBlocks(newMsg, pendingBlocks);
            pendingBlocks = [];
          }
          messages.push(newMsg);
        }
      } else if (item.type === "function_call_output") {
        const toolResult = {
          type: "tool_result",
          tool_use_id: item.call_id || item.id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        };
        // Merge into previous message if it's a user (keeps tool_results together)
        const last = messages[messages.length - 1];
        if (last && last.role === "user") {
          if (typeof last.content === "string") {
            last.content = [{ type: "text", text: last.content }, toolResult];
          } else if (Array.isArray(last.content)) {
            last.content.push(toolResult);
          } else {
            last.content = [toolResult];
          }
        } else {
          messages.push({ role: "user", content: [toolResult] });
        }
      } else if (item.type === "web_search_call") {
        const toolUse = {
          type: "tool_use",
          id: item.call_id || "ws_" + Math.random().toString(36).slice(2, 10),
          name: "web_search",
          input: item.action || {},
        };
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          if (typeof last.content === "string") {
            last.content = [{ type: "text", text: last.content }, toolUse];
          } else if (Array.isArray(last.content)) {
            last.content.push(toolUse);
          } else {
            last.content = [toolUse];
          }
        } else {
          messages.push({ role: "assistant", content: [toolUse] });
        }
      } else if (item.type === "web_search_call_output") {
        const toolResult = {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""),
        };
        const last = messages[messages.length - 1];
        if (last && last.role === "user") {
          if (typeof last.content === "string") {
            last.content = [{ type: "text", text: last.content }, toolResult];
          } else if (Array.isArray(last.content)) {
            last.content.push(toolResult);
          } else {
            last.content = [toolResult];
          }
        } else {
          messages.push({ role: "user", content: [toolResult] });
        }
      } else if (item.type === "custom_tool_call") {
        const toolUse = {
          type: "tool_use",
          id: item.call_id || "ct_" + Math.random().toString(36).slice(2, 10),
          name: item.name || "custom_tool",
          input: item.input || {},
        };
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          if (typeof last.content === "string") {
            last.content = [{ type: "text", text: last.content }, toolUse];
          } else if (Array.isArray(last.content)) {
            last.content.push(toolUse);
          } else {
            last.content = [toolUse];
          }
        } else {
          messages.push({ role: "assistant", content: [toolUse] });
        }
      } else if (item.type === "custom_tool_call_output") {
        const toolResult = {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""),
        };
        const last = messages[messages.length - 1];
        if (last && last.role === "user") {
          if (typeof last.content === "string") {
            last.content = [{ type: "text", text: last.content }, toolResult];
          } else if (Array.isArray(last.content)) {
            last.content.push(toolResult);
          } else {
            last.content = [toolResult];
          }
        } else {
          messages.push({ role: "user", content: [toolResult] });
        }
      } else if (item.type === "computer_call") {
        // Codex computer use action → Anthropic tool_use block
        const input = Object.assign({}, item.action || {});
        if (item.coordinate) input.coordinate = item.coordinate;
        if (item.text) input.text = item.text;
        if (item.key) input.key = item.key;
        const toolUse = {
          type: "tool_use",
          id: item.call_id || item.id || "cu_" + Math.random().toString(36).slice(2, 12),
          name: "computer",
          input: input,
        };
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          if (typeof last.content === "string") {
            last.content = [{ type: "text", text: last.content }, toolUse];
          } else if (Array.isArray(last.content)) {
            last.content.push(toolUse);
          } else {
            last.content = [toolUse];
          }
        } else {
          messages.push({ role: "assistant", content: [toolUse] });
        }
      } else if (item.type === "computer_call_output") {
        // Codex computer use result (screenshot, etc.) → Anthropic tool_result
        const content = [];
        const output = item.output;
        if (typeof output === "string") {
          content.push({ type: "text", text: output });
        } else if (Array.isArray(output)) {
          for (const part of output) {
            if (typeof part === "string") {
              content.push({ type: "text", text: part });
            } else if (part && part.type === "image_url") {
              const url = part.image_url ? part.image_url.url : part.url || "";
              if (url.startsWith("data:")) {
                const m = url.match(/^data:([^;]+);base64,(.+)$/);
                if (m) {
                  content.push({
                    type: "image",
                    source: { type: "base64", media_type: m[1], data: m[2] },
                  });
                }
              }
            } else if (part && part.type === "image" && part.source) {
              content.push(part);
            }
          }
        } else if (output && typeof output === "object" && output.type === "screenshot") {
          // Direct screenshot object
          if (output.image_url) {
            const url = output.image_url.url || output.image_url;
            if (url && url.startsWith("data:")) {
              const m = url.match(/^data:([^;]+);base64,(.+)$/);
              if (m) {
                content.push({
                  type: "image",
                  source: { type: "base64", media_type: m[1], data: m[2] },
                });
              }
            }
          }
        }
        const toolResult = {
          type: "tool_result",
          tool_use_id: item.call_id || item.id,
          content: content.length > 0 ? content : typeof output === "string" ? output : JSON.stringify(output || {}),
        };
        const last = messages[messages.length - 1];
        if (last && last.role === "user") {
          if (typeof last.content === "string") {
            last.content = [{ type: "text", text: last.content }, toolResult];
          } else if (Array.isArray(last.content)) {
            last.content.push(toolResult);
          } else {
            last.content = [toolResult];
          }
        } else {
          messages.push({ role: "user", content: [toolResult] });
        }
        continue;
      }
    }

    // Flush any remaining pending blocks into the last assistant message
    if (pendingBlocks.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          prependThinkingBlocks(messages[i], pendingBlocks);
          pendingBlocks = [];
          break;
        }
      }
      if (pendingBlocks.length > 0) {
        messages.push({ role: "assistant", content: pendingBlocks });
      }
    }
  }

  return { messages, systemParts };
}

function prependThinkingBlocks(msg, blocks) {
  if (typeof msg.content === "string") {
    msg.content = [...blocks, { type: "text", text: msg.content }];
  } else if (Array.isArray(msg.content)) {
    // Dedup: skip blocks already present (by text match)
    const existingTexts = new Set(
      msg.content
        .filter(function (c) {
          return c.type === "thinking";
        })
        .map(function (c) {
          return c.thinking;
        }),
    );
    for (let b = blocks.length - 1; b >= 0; b--) {
      if (!existingTexts.has(blocks[b].thinking)) {
        msg.content.unshift(blocks[b]);
      }
    }
  } else {
    msg.content = blocks;
  }
}

function convertMessageItem(item, provider) {
  const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
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
  return tools.flatMap((t) => {
    if (!t) return [];
    if (t.type === "function" || t.type === "custom") {
      return [
        {
          name: t.name,
          description: t.description || "",
          input_schema: t.parameters || t.input_schema || { type: "object", properties: {} },
        },
      ];
    }
    if (t.type === "namespace" && Array.isArray(t.tools)) {
      return t.tools
        .filter((sub) => sub && (sub.type === "function" || sub.type === "custom"))
        .map((sub) => ({
          name: t.name + "_" + sub.name,
          description: sub.description || "",
          input_schema: sub.parameters || sub.input_schema || { type: "object", properties: {} },
        }));
    }
    if (t.type === "computer_use" || t.type === "computer") {
      return [
        {
          type: "computer_20250124",
          name: t.name || "computer",
          display_width_px: t.display_width || t.display_width_px || 1024,
          display_height_px: t.display_height || t.display_height_px || 768,
          display_number: t.display_number !== undefined ? t.display_number : 1,
        },
      ];
    }
    return [];
  });
}

function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "auto":
        return { type: "auto" };
      case "required":
        return { type: "any" };
      case "none":
        return undefined;
      default:
        return { type: "tool", name: toolChoice };
    }
  }
  if (toolChoice.type === "function") {
    const name = toolChoice.function && toolChoice.function.name;
    return name ? { type: "tool", name } : undefined;
  }
  if (toolChoice.type === "allowed_tools") {
    return { type: "any" };
  }
  return undefined;
}

function safeParseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Stream an Anthropic Messages request and emit Responses API SSE events.
 *
 * Handles Anthropic SSE event sequence: message_start �?content_block_start �?
 * content_block_delta (thinking/text/input_json/signature) �?content_block_stop �?
 * message_delta �?message_stop. Signature deltas are discarded.
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
 * @param {object} [traceSession] - Optional trace session for raw SSE capture
 * @returns {Promise<void>}
 */
async function streamUpstream(upstreamPayload, provider, emit, traceSession) {
  const baseUrl = (provider.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const url = baseUrl + "/v1/messages";

  const hooksS = getHooks(provider);
  const extraHdrS = hooksS && hooksS.getHeaders ? hooksS.getHeaders(provider) : {};

  const headers = Object.assign(
    {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey || "",
      "anthropic-version": "2023-06-01",
    },
    ...(upstreamPayload._betas && upstreamPayload._betas.length > 0 ? [{ "anthropic-beta": upstreamPayload._betas.join(",") }] : []),
    extraHdrS,
  );

  const body = Object.assign({}, upstreamPayload);
  delete body.system;
  const requestPayload = upstreamPayload.system ? Object.assign({}, body, { system: upstreamPayload.system }) : body;
  delete requestPayload._betas;

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

    dumpRequestThinking(upstreamPayload, provider);
    if (res.statusCode === 400 && msg.includes("signature")) {
      emit(errorEvent("Anthropic signature error - retrying without signatures is not yet supported. " + msg, "signature_error"));
    } else {
      emit(errorEvent(msg, "upstream_" + res.statusCode));
    }
    return;
  }

  let usage = null;
  let stopReason = null;
  const toolCalls = {};
  let _currentBlockType = null;
  let currentBlockIndex = -1;
  let streamEndedCleanly = false;
  let thinkingText = "";
  let thinkingSignature = "";
  const thinkParser = new ThinkingTagStreamParser();

  for await (const chunk of parseSSEStream(res.body)) {
    if (traceSession) traceSession.logRawLine(chunk);
    let data;
    try {
      data = JSON.parse(chunk);
    } catch {
      log.warn("[anthropic] unparseable SSE chunk");
      continue;
    }

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
      if (data.delta && data.delta.stop_reason) {
        if (data.delta.stop_reason === "max_tokens" || data.delta.stop_reason === "tool_use") {
          stopReason = data.delta.stop_reason;
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
      } else if (block.type === "thinking") {
        thinkingText = "";
        thinkingSignature = "";
      }
      continue;
    }

    if (eventType === "content_block_delta") {
      const delta = data.delta;
      if (!delta) continue;

      if (delta.type === "thinking_delta") {
        thinkingText += delta.thinking || "";
        if (delta.thinking) {
          emit(reasoningDeltaEvent(delta.thinking));
        }
      } else if (delta.type === "text_delta") {
        const parsed = thinkParser.feed(delta.text || "");
        if (parsed.reasoning) emit(reasoningDeltaEvent(parsed.reasoning));
        if (parsed.text) emit(textDeltaEvent(parsed.text));
      } else if (delta.type === "input_json_delta") {
        const tc = toolCalls[currentBlockIndex];
        if (tc) {
          tc.args += delta.partial_json || "";
          emit(toolCallArgsDeltaEvent(tc.id, delta.partial_json || ""));
        }
      } else if (delta.type === "signature_delta") {
        thinkingSignature += delta.signature || "";
      }
      continue;
    }

    if (eventType === "content_block_stop") {
      if (_currentBlockType === "thinking" && thinkingText && thinkingSignature) {
        reasoningCache.store(thinkingText, thinkingSignature);
      }
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
    const flushed = thinkParser.flush();
    if (flushed.reasoning) emit(reasoningDeltaEvent(flushed.reasoning));
    if (flushed.text) emit(textDeltaEvent(flushed.text));
    emit(errorEvent("Upstream stream ended unexpectedly", "stream_interrupted"));
    return;
  }

  const flushed = thinkParser.flush();
  if (flushed.reasoning) emit(reasoningDeltaEvent(flushed.reasoning));
  if (flushed.text) emit(textDeltaEvent(flushed.text));

  if (stopReason === "max_tokens") {
    emit(responseIncompleteEvent(stopReason));
  } else {
    emit(responseCompletedEvent(usage));
  }
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
 * @param {object} [traceSession] - Optional trace session for raw response capture
 * @returns {Promise<{text: string, reasoning: string, toolCalls: Array, usage: object|null}>}
 */
async function callUpstream(upstreamPayload, provider, traceSession) {
  const payload = Object.assign({}, upstreamPayload, { stream: false });
  const betas = payload._betas;
  delete payload._betas;
  // thinking config is preserved — Anthropic supports it in non-streaming mode
  // unlike the _betas internal flag which must be sent via header
  const baseUrl = (provider.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const url2 = baseUrl + "/v1/messages";

  const hooksC = getHooks(provider);
  const extraHdrC = hooksC && hooksC.getHeaders ? hooksC.getHeaders(provider) : {};

  const headers = Object.assign(
    {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey || "",
      "anthropic-version": "2023-06-01",
    },
    ...(betas && betas.length > 0 ? [{ "anthropic-beta": betas.join(",") }] : []),
    extraHdrC,
  );

  const res = await request(url2, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    headersTimeout: 30000,
    bodyTimeout: 120000,
  });

  const responseBody = await res.body.text();
  if (traceSession) traceSession.logRawLine(responseBody);
  if (res.statusCode !== 200) {
    let msg = "Upstream returned HTTP " + res.statusCode;
    try {
      msg = JSON.parse(responseBody).error.message || msg;
    } catch {}
    dumpRequestThinking(payload, provider);
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
        if (block.thinking && block.signature) {
          reasoningCache.store(block.thinking, block.signature);
        }
      } else if (block.type === "text") {
        // Strip inline thinking tags from text (belt-and-suspenders for
        // providers that inline thinking inside text blocks).
        const extracted = extractThinkingTags(block.text || "");
        result.text += extracted.text;
        if (extracted.reasoning) {
          result.reasoning = result.reasoning ? result.reasoning + "\n\n" + extracted.reasoning : extracted.reasoning;
        }
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

function dumpRequestThinking(payload, _provider) {
  if (!payload || !Array.isArray(payload.messages)) return;
  const lines = [];
  for (let m = 0; m < payload.messages.length; m++) {
    const msg = payload.messages[m];
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      lines.push("  msg[" + m + "] assistant text(" + content.length + ") no_thinking");
      continue;
    }
    if (!Array.isArray(content)) {
      lines.push("  msg[" + m + "] assistant <no content>");
      continue;
    }
    const hasThinking = content.some(function (b) {
      return b.type === "thinking";
    });
    const blocks = content.map(function (b) {
      if (b.type === "thinking") {
        const txt = b.thinking || "";
        const prefix = txt.length > 50 ? txt.slice(0, 50) + "..." : txt;
        return "thinking(len=" + txt.length + ",sig=" + (b.signature ? "yes" : "NO") + ") " + prefix;
      }
      if (b.type === "text") return "text(" + (b.text ? b.text.length : 0) + ")";
      if (b.type === "tool_use") return "tool_use(" + (b.name || "?") + ")";
      if (b.type === "tool_result") return "tool_result";
      return b.type || "?";
    });
    lines.push("  msg[" + m + "] assistant" + (hasThinking ? "" : " NO_THINKING") + ": [" + blocks.join(", ") + "]");
  }
  log.warn("[anthropic] upstream error — thinking state (" + payload.messages.length + " msgs):\n" + lines.join("\n"));
}

module.exports = {
  buildUpstreamRequest,
  streamUpstream,
  callUpstream,
};
