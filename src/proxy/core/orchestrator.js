"use strict";

const { makeId } = require("../../shared/http");
const { createSseBridge } = require("./sse-bridge");
const { errorEvent } = require("./events");
const { getHooks } = require("../presets");
const { createTraceSession } = require("../../shared/trace");
const log = require("../../shared/logger");

async function orchestrate(req, res, requestBody, provider, settings) {
  const responseId = makeId("resp");
  const model = provider.model || requestBody.model || "unknown";
  const stream = requestBody.stream !== false;

  log.info("Request → " + provider.name + " | model=" + model + " | stream=" + stream, { provider: provider.name, requestId: responseId });

  const adapter = resolveAdapter(provider.protocol);
  if (!adapter) {
    log.error("Unsupported protocol: " + provider.protocol, { provider: provider.name, requestId: responseId });
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Unsupported protocol: " + provider.protocol, type: "invalid_request_error", code: "unsupported_protocol" },
      }),
    );
    return;
  }

  // Trace session — activated by settings.traceEnabled toggle in UI
  const trace = createTraceSession(settings, model);
  if (trace) {
    trace.logRequest(requestBody);
    log.info("Trace enabled — writing to trace directory", { provider: provider.name, requestId: responseId });
  }

  log.debug(
    "Input items: " +
      (requestBody.input ? requestBody.input.length : 0) +
      " | tools: " +
      (requestBody.tools ? requestBody.tools.length : 0),
    { provider: provider.name, requestId: responseId },
  );

  const upstreamRequest = adapter.buildUpstreamRequest(requestBody, provider, settings);

  log.debug(
    "Upstream messages: " +
      (upstreamRequest.messages ? upstreamRequest.messages.length : 0) +
      " | model=" +
      upstreamRequest.model +
      " | stream=" +
      upstreamRequest.stream,
    { provider: provider.name, requestId: responseId },
  );

  // Run vendor preset hooks (e.g. DeepSeek reasoning_content passthrough)
  const hooks = getHooks(provider);
  if (hooks && hooks.onMessagesBuilt) {
    upstreamRequest.messages = hooks.onMessagesBuilt(upstreamRequest.messages, requestBody, provider);
  }

  // Let hooks modify the upstream payload (e.g. Kimi forces temperature=1.0)
  if (hooks && hooks.onUpstreamPayload) {
    hooks.onUpstreamPayload(upstreamRequest, provider);
  }

  if (trace) trace.logUpstream(upstreamRequest);

  if (stream) {
    const bridge = createSseBridge(res, responseId, model, trace);
    try {
      await adapter.streamUpstream(
        upstreamRequest,
        provider,
        (event) => {
          bridge.handleEvent(event);
        },
        trace,
      );
      log.info("Stream done — " + provider.name + " | model=" + model, { provider: provider.name, requestId: responseId });
    } catch (err) {
      log.error("Stream failed: " + err.message, { provider: provider.name, requestId: responseId });
      bridge.handleEvent(errorEvent(err.message || "Upstream request failed", "upstream_error"));
    } finally {
      if (trace) trace.close();
    }
  } else {
    try {
      if (trace) trace.logUpstream(upstreamRequest);
      const result = await adapter.callUpstream(upstreamRequest, provider, trace);
      const response = buildSyncResponse(responseId, model, result);
      if (trace) {
        trace.logRawLine(JSON.stringify(response));
        trace.close();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      log.info("Sync response — " + provider.name + " | model=" + model, { provider: provider.name, requestId: responseId });
    } catch (err) {
      if (trace) trace.close();
      log.error("Sync request failed: " + err.message, { provider: provider.name, requestId: responseId });
      res.writeHead(err.statusCode || 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message || "Upstream request failed", type: "api_error", code: "upstream_error" } }));
    }
  }
}

function resolveAdapter(protocol) {
  if (protocol === "openai-chat" || protocol === "openai") {
    return require("../adapters/openai-chat");
  }
  if (protocol === "anthropic") {
    return require("../adapters/anthropic");
  }
  return null;
}

function buildSyncResponse(responseId, model, result) {
  const output = [];
  if (result.reasoning) {
    output.push({
      id: makeId("rs"),
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: result.reasoning }],
    });
  }
  if (result.text) {
    output.push({
      id: makeId("msg"),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    });
  }
  if (result.toolCalls && result.toolCalls.length > 0) {
    for (const tc of result.toolCalls) {
      output.push({
        id: makeId("fc"),
        type: "function_call",
        call_id: tc.id || makeId("call"),
        name: tc.name,
        status: "completed",
        arguments: tc.arguments || "{}",
      });
    }
  }
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    usage: result.usage || null,
  };
}

module.exports = { orchestrate };
