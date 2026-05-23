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
  RESPONSE_INCOMPLETE: "response_incomplete",
  REFUSAL_DELTA: "refusal_delta",
  REASONING_TEXT_DELTA: "reasoning_text_delta",
  ANNOTATION_ADDED: "annotation_added",
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

function responseIncompleteEvent(reason) {
  return { type: EventType.RESPONSE_INCOMPLETE, reason };
}

function refusalDeltaEvent(delta) {
  return { type: EventType.REFUSAL_DELTA, delta };
}

function reasoningTextDeltaEvent(delta) {
  return { type: EventType.REASONING_TEXT_DELTA, delta };
}

function annotationAddedEvent(annotation) {
  return { type: EventType.ANNOTATION_ADDED, annotation };
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
  responseIncompleteEvent,
  refusalDeltaEvent,
  reasoningTextDeltaEvent,
  annotationAddedEvent,
};
