"use strict";

const EventType = {
  RESPONSE_CREATED: "response_created",
  REASONING_DELTA: "reasoning_delta",
  TEXT_DELTA: "text_delta",
  TOOL_CALL_START: "tool_call_start",
  TOOL_CALL_ARGS_DELTA: "tool_call_args_delta",
  TOOL_CALL_END: "tool_call_end",
  RESPONSE_COMPLETED: "response_completed",
  ERROR: "error",
};

function responseCreatedEvent(meta) {
  return { type: EventType.RESPONSE_CREATED, meta };
}

function reasoningDeltaEvent(delta) {
  return { type: EventType.REASONING_DELTA, delta };
}

function textDeltaEvent(delta) {
  return { type: EventType.TEXT_DELTA, delta };
}

function toolCallStartEvent(callId, name) {
  return { type: EventType.TOOL_CALL_START, callId, name };
}

function toolCallArgsDeltaEvent(callId, delta) {
  return { type: EventType.TOOL_CALL_ARGS_DELTA, callId, delta };
}

function toolCallEndEvent(callId, name, args) {
  return { type: EventType.TOOL_CALL_END, callId, name, args };
}

function responseCompletedEvent(usage) {
  return { type: EventType.RESPONSE_COMPLETED, usage };
}

function errorEvent(message, code) {
  return { type: EventType.ERROR, message, code };
}

module.exports = {
  EventType,
  responseCreatedEvent,
  reasoningDeltaEvent,
  textDeltaEvent,
  toolCallStartEvent,
  toolCallArgsDeltaEvent,
  toolCallEndEvent,
  responseCompletedEvent,
  errorEvent,
};
