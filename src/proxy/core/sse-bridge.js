"use strict";

const { makeId, nowSeconds, createSequence, emitSse } = require("../../shared/http");
const { EventType } = require("./events");

function createSseBridge(res, responseId, model, traceSession) {
  const seq = createSequence();
  const createdAt = nowSeconds();
  let outputIndex = 0;
  const output = [];

  let reasoningItem = null;
  let messageItem = null;
  const toolCallItems = new Map();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (res.socket && typeof res.socket.setNoDelay === "function") res.socket.setNoDelay(true);
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const responseMeta = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    model,
    status: "in_progress",
    output: [],
  };

  function emitToClient(eventType, data) {
    if (traceSession) traceSession.logOutEvent(eventType, data);
    emitSse(res, eventType, data);
  }

  emitToClient("response.created", {
    type: "response.created",
    response: responseMeta,
    sequence_number: seq.next(),
  });
  emitToClient("response.in_progress", {
    type: "response.in_progress",
    response: responseMeta,
    sequence_number: seq.next(),
  });

  function handleEvent(event) {
    if (res.writableEnded) return;
    switch (event.type) {
      case EventType.REASONING_DELTA:
        handleReasoningDelta(event.delta);
        break;
      case EventType.TEXT_DELTA:
        handleTextDelta(event.delta);
        break;
      case EventType.TOOL_CALL_START:
        handleToolCallStart(event.callId, event.name);
        break;
      case EventType.TOOL_CALL_ARGS_DELTA:
        handleToolCallArgsDelta(event.callId, event.delta);
        break;
      case EventType.TOOL_CALL_END:
        handleToolCallEnd(event.callId, event.name, event.args);
        break;
      case EventType.RESPONSE_COMPLETED:
        handleCompleted(event.usage);
        break;
      case EventType.ERROR:
        handleError(event.message, event.code);
        break;
    }
  }

  function handleReasoningDelta(delta) {
    if (!reasoningItem) {
      closeMessage(); // flush any open message before starting a new reasoning block
      reasoningItem = { id: makeId("rs"), outputIndex: outputIndex++, text: "" };
      emitToClient("response.output_item.added", {
        type: "response.output_item.added",
        response_id: responseId,
        output_index: reasoningItem.outputIndex,
        item: { id: reasoningItem.id, type: "reasoning", status: "in_progress", summary: [] },
        sequence_number: seq.next(),
      });
      emitToClient("response.reasoning_summary_part.added", {
        type: "response.reasoning_summary_part.added",
        response_id: responseId,
        item_id: reasoningItem.id,
        output_index: reasoningItem.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
        sequence_number: seq.next(),
      });
    }
    reasoningItem.text += delta;
    emitToClient("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      response_id: responseId,
      item_id: reasoningItem.id,
      output_index: reasoningItem.outputIndex,
      summary_index: 0,
      delta,
      sequence_number: seq.next(),
    });
  }

  function closeReasoning() {
    if (!reasoningItem) return;
    emitToClient("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      response_id: responseId,
      item_id: reasoningItem.id,
      output_index: reasoningItem.outputIndex,
      summary_index: 0,
      text: reasoningItem.text,
      sequence_number: seq.next(),
    });
    emitToClient("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      response_id: responseId,
      item_id: reasoningItem.id,
      output_index: reasoningItem.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: reasoningItem.text },
      sequence_number: seq.next(),
    });
    const item = {
      id: reasoningItem.id,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningItem.text }],
    };
    emitToClient("response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: reasoningItem.outputIndex,
      item,
      sequence_number: seq.next(),
    });
    output.push(item);
    reasoningItem = null;
  }

  function handleTextDelta(delta) {
    closeReasoning();
    if (!messageItem) {
      messageItem = { id: makeId("msg"), outputIndex: outputIndex++, text: "" };
      emitToClient("response.output_item.added", {
        type: "response.output_item.added",
        response_id: responseId,
        output_index: messageItem.outputIndex,
        item: { id: messageItem.id, type: "message", role: "assistant", status: "in_progress", content: [] },
        sequence_number: seq.next(),
      });
      emitToClient("response.content_part.added", {
        type: "response.content_part.added",
        response_id: responseId,
        item_id: messageItem.id,
        output_index: messageItem.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
        sequence_number: seq.next(),
      });
    }
    messageItem.text += delta;
    emitToClient("response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: responseId,
      item_id: messageItem.id,
      output_index: messageItem.outputIndex,
      content_index: 0,
      delta,
      sequence_number: seq.next(),
    });
  }

  function closeMessage() {
    if (!messageItem) return;
    emitToClient("response.output_text.done", {
      type: "response.output_text.done",
      response_id: responseId,
      item_id: messageItem.id,
      output_index: messageItem.outputIndex,
      content_index: 0,
      text: messageItem.text,
      sequence_number: seq.next(),
    });
    emitToClient("response.content_part.done", {
      type: "response.content_part.done",
      response_id: responseId,
      item_id: messageItem.id,
      output_index: messageItem.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: messageItem.text, annotations: [] },
      sequence_number: seq.next(),
    });
    const item = {
      id: messageItem.id,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: messageItem.text, annotations: [] }],
    };
    emitToClient("response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: messageItem.outputIndex,
      item,
      sequence_number: seq.next(),
    });
    output.push(item);
    messageItem = null;
  }

  function handleToolCallStart(callId, name) {
    closeReasoning();
    closeMessage();
    const idx = outputIndex++;
    const item = { id: makeId("fc"), callId, name, outputIndex: idx, args: "" };
    toolCallItems.set(callId, item);
    emitToClient("response.output_item.added", {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: idx,
      item: { id: item.id, type: "function_call", call_id: callId, name, status: "in_progress", arguments: "" },
      sequence_number: seq.next(),
    });
  }

  function handleToolCallArgsDelta(callId, delta) {
    const item = toolCallItems.get(callId);
    if (!item) return;
    item.args += delta;
    emitToClient("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      response_id: responseId,
      item_id: item.id,
      output_index: item.outputIndex,
      delta,
      sequence_number: seq.next(),
    });
  }

  function handleToolCallEnd(callId, name, args) {
    const item = toolCallItems.get(callId);
    if (!item) return;
    item.args = args || item.args;
    emitToClient("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: responseId,
      item_id: item.id,
      output_index: item.outputIndex,
      arguments: item.args,
      sequence_number: seq.next(),
    });
    const doneItem = {
      id: item.id,
      type: "function_call",
      call_id: callId,
      name: item.name,
      status: "completed",
      arguments: item.args,
    };
    emitToClient("response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: item.outputIndex,
      item: doneItem,
      sequence_number: seq.next(),
    });
    output.push(doneItem);
    toolCallItems.delete(callId);
  }

  function handleCompleted(usage) {
    closeReasoning();
    closeMessage();
    const response = {
      id: responseId,
      object: "response",
      created_at: createdAt,
      model,
      status: "completed",
      output,
      usage: usage || null,
    };
    emitToClient("response.completed", {
      type: "response.completed",
      response,
      sequence_number: seq.next(),
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  function handleError(message, code) {
    closeReasoning();
    closeMessage();
    const response = {
      id: responseId,
      object: "response",
      created_at: createdAt,
      model,
      status: "failed",
      output,
      error: { message: message || "Unknown error", type: "api_error", code: code || "upstream_error" },
    };
    emitToClient("response.failed", {
      type: "response.failed",
      response,
      sequence_number: seq.next(),
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  return { handleEvent, output };
}

module.exports = { createSseBridge };
