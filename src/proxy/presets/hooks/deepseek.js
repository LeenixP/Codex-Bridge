"use strict";

const log = require("../../../shared/logger");

/**
 * DeepSeek reasoning passthrough hook.
 *
 * DeepSeek requires reasoning/thinking echoed back in multi-turn conversations.
 * The format depends on the protocol:
 *   openai-chat → reasoning_content field on assistant message
 *   anthropic   → thinking content block prepended to assistant content
 *
 * Each reasoning item in the input corresponds to the next assistant message,
 * so we pair them sequentially: first reasoning → first assistant, etc.
 */
function onMessagesBuilt(messages, requestBody, provider) {
  const inputItems = requestBody && requestBody.input;
  if (!Array.isArray(inputItems)) return messages;

  const reasoningTexts = [];
  for (let i = 0; i < inputItems.length; i++) {
    const item = inputItems[i];
    if (item && item.type === "reasoning") {
      const text = extractSummary(item);
      if (text) reasoningTexts.push(text);
    }
  }
  if (reasoningTexts.length === 0) return messages;

  let rIdx = 0;
  let injectedCount = 0;
  for (let m = 0; m < messages.length && rIdx < reasoningTexts.length; m++) {
    if (messages[m].role !== "assistant") continue;
    const reasoningText = reasoningTexts[rIdx++];

    if (provider.protocol === "anthropic") {
      injectAnthropic(messages[m], reasoningText);
    } else {
      messages[m].reasoning_content = (messages[m].reasoning_content || "") + reasoningText;
    }
    injectedCount++;
  }

  if (injectedCount > 0) {
    log.info("[deepseek] reasoning injected into " + injectedCount + " assistant msg(s) → " + provider.protocol, { provider: provider.name });
  } else {
    const hasAssistant = messages.some(function (m) { return m.role === "assistant"; });
    if (hasAssistant) {
      log.warn("[deepseek] expected reasoning but none found in input (" + messages.length + " msgs, " + reasoningTexts.length + " reasoning items)", { provider: provider.name });
    }
  }

  return messages;
}

function injectAnthropic(msg, reasoningText) {
  if (typeof msg.content === "string") {
    msg.content = [{ type: "thinking", thinking: reasoningText }, { type: "text", text: msg.content }];
  } else if (Array.isArray(msg.content)) {
    if (!msg.content.some(function (b) { return b.type === "thinking" && b.thinking === reasoningText; })) {
      msg.content.unshift({ type: "thinking", thinking: reasoningText });
    }
  }
}

function extractSummary(item) {
  if (!item || !item.summary) return "";
  const summary = Array.isArray(item.summary) ? item.summary : [item.summary];
  let text = "";
  for (let j = 0; j < summary.length; j++) {
    text += summary[j].text || "";
  }
  return text;
}

module.exports = { onMessagesBuilt };
