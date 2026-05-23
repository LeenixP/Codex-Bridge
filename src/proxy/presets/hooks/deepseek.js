"use strict";

const log = require("../../../shared/logger");
const reasoningCache = require("../../core/reasoning-cache");

/**
 * DeepSeek reasoning passthrough hook.
 *
 * DeepSeek requires reasoning/thinking echoed back in multi-turn conversations.
 * The format depends on the protocol:
 *   openai-chat → reasoning_content field on assistant message
 *   anthropic   → thinking content block prepended to assistant content
 *
 * Key design decision: Codex reasoning items contain summary arrays where each
 * summary maps to one Anthropic thinking block.  We must preserve the 1:1
 * mapping so each thinking block can carry its own cryptographic signature.
 * Concatenating summaries into a single thinking block would lose signatures.
 *
 * Strategy:
 *   1. For each reasoning item, extract individual summary texts.
 *   2. Look up each summary in the signature cache.
 *   3. Find the target assistant message (next message/role item in the input).
 *   4. Simulate the adapter's message-creation rules for accurate index mapping.
 *   5. Inject thinking blocks into the correct assistant messages.
 */
function onMessagesBuilt(messages, requestBody, provider) {
  const inputItems = requestBody && requestBody.input;
  if (!Array.isArray(inputItems)) return messages;

  // 1. Collect (thinkingBlocks[], targetInputIdx) pairs.
  //    Each reasoning item expands to N thinking blocks (one per summary).
  const pairs = [];
  for (let i = 0; i < inputItems.length; i++) {
    const item = inputItems[i];
    if (!item || item.type !== "reasoning") continue;

    const blocks = buildThinkingBlocks(item);
    if (blocks.length === 0) continue;

    let targetIdx = -1;
    for (let j = i + 1; j < inputItems.length; j++) {
      const n = inputItems[j];
      if (!n || typeof n !== "object") continue;
      // Match items that produce messages in the adapter:
      //   message items, role-carrying items, AND function_call items
      //   (function_call creates a new assistant message when there is
      //   no preceding assistant to merge into).
      if (n.type === "message" || n.type === "function_call" || n.role) {
        targetIdx = j;
        break;
      }
    }
    pairs.push({ blocks, targetIdx });
  }

  if (pairs.length === 0) return messages;

  // 2. Simulate the adapter's message-creation rules to build an accurate
  //    input→message index map.
  const inputToMsg = [];
  let msgIdx = 0;
  let lastRole = null;

  for (let i = 0; i < inputItems.length; i++) {
    const it = inputItems[i];
    if (!it || typeof it !== "object") {
      inputToMsg[i] = -1;
      continue;
    }

    if (it.type === "reasoning") {
      inputToMsg[i] = -1;
      continue;
    }

    if (it.type === "function_call") {
      if (lastRole === "assistant" && msgIdx > 0) {
        inputToMsg[i] = msgIdx - 1;
      } else {
        inputToMsg[i] = msgIdx++;
        lastRole = "assistant";
      }
      continue;
    }

    if (it.type === "function_call_output") {
      if (lastRole === "user" && msgIdx > 0) {
        inputToMsg[i] = msgIdx - 1;
      } else {
        inputToMsg[i] = msgIdx++;
        lastRole = "user";
      }
      continue;
    }

    if (provider.protocol === "anthropic" && (it.role === "system" || (it.type === "message" && it.role === "system"))) {
      inputToMsg[i] = -1;
      continue;
    }

    var role = it.role || "user";
    inputToMsg[i] = msgIdx++;
    lastRole = role;
  }

  // 3. Inject thinking blocks into the correct assistant messages.
  let injectedBlocks = 0;
  for (var p = 0; p < pairs.length; p++) {
    var pair = pairs[p];
    var blocks = pair.blocks;
    var targetIdx = pair.targetIdx;

    // Edge case: reasoning at end of input with no following message.
    if (targetIdx < 0) {
      for (var rm = messages.length - 1; rm >= 0; rm--) {
        if (messages[rm].role === "assistant") {
          injectIntoMessage(messages[rm], blocks, provider.protocol);
          injectedBlocks += blocks.length;
          break;
        }
      }
      continue;
    }

    var m = inputToMsg[targetIdx];
    if (m == null || m < 0 || m >= messages.length) {
      log.warn(
        "[deepseek] target out of bounds: inputIdx=" + targetIdx + " → msgIdx=" + m +
        " (total " + messages.length + " msgs)",
        { provider: provider.name }
      );
      dumpInputStructure(inputItems, messages, provider);
      continue;
    }

    if (messages[m].role !== "assistant") {
      var found = false;
      for (var fwd = m + 1; fwd < messages.length; fwd++) {
        if (messages[fwd].role === "assistant") {
          injectIntoMessage(messages[fwd], blocks, provider.protocol);
          injectedBlocks += blocks.length;
          found = true;
          break;
        }
      }
      if (!found) {
        log.warn(
          "[deepseek] target msgIdx=" + m + " is " + messages[m].role +
          ", no trailing assistant found",
          { provider: provider.name }
        );
        dumpInputStructure(inputItems, messages, provider);
      }
    } else {
      injectIntoMessage(messages[m], blocks, provider.protocol);
      injectedBlocks += blocks.length;
    }
  }

  // 4. Diagnostic logging.
  var totalAssistant = messages.reduce(function (c, msg) { return c + (msg.role === "assistant" ? 1 : 0); }, 0);

  var totalReasoningItems = pairs.length;
  var totalSummaries = pairs.reduce(function (c, p) { return c + p.blocks.length; }, 0);

  // Dump reasoning→target pairing at debug level
  if (totalReasoningItems > 0) {
    var pairLines = pairs.map(function (p, idx) {
      var m = p.targetIdx >= 0 ? inputToMsg[p.targetIdx] : -1;
      var role = (m >= 0 && m < messages.length) ? messages[m].role : "?";
      return "  reasoning[" + idx + "] → input[" + p.targetIdx + "] → msg[" + m + "](" + role + ") blocks=" + p.blocks.length;
    });
    log.debug(
      "[deepseek] pairings:\n" + pairLines.join("\n"),
      { provider: provider.name }
    );
  }

  log.debug(
    "[deepseek] scan: " + totalReasoningItems + " reasoning items (" + totalSummaries +
    " summaries) → " + injectedBlocks + " thinking blocks injected | " +
    totalAssistant + " assistant msgs in " + messages.length + " total | " +
    inputItems.length + " input items",
    { provider: provider.name }
  );

  if (injectedBlocks > 0) {
    log.info(
      "[deepseek] reasoning injected: " + totalSummaries + " summaries → " +
      injectedBlocks + " thinking blocks across " + totalAssistant + " assistant msgs → " +
      provider.protocol,
      { provider: provider.name }
    );
    dumpThinkingBlocks(messages, provider);
  } else if (totalAssistant > 0) {
    log.warn(
      "[deepseek] expected reasoning but injected 0 (" + totalReasoningItems +
      " reasoning items, " + totalAssistant + " assistant msgs)",
      { provider: provider.name }
    );
    dumpInputStructure(inputItems, messages, provider);
  }

  return messages;
}

/**
 * Build one thinking block per summary in a reasoning item.
 * Each block looks up its signature in the cache.
 */
function buildThinkingBlocks(item) {
  if (!item || !item.summary) return [];
  var summary = Array.isArray(item.summary) ? item.summary : [item.summary];
  var blocks = [];
  for (var j = 0; j < summary.length; j++) {
    var text = summary[j].text || "";
    if (!text) continue;
    var sig = reasoningCache.get(text);
    var block = { type: "thinking", thinking: text };
    if (sig) block.signature = sig;
    blocks.push(block);
  }
  return blocks;
}

/**
 * Inject thinking blocks into a message (protocol-aware).
 */
function injectIntoMessage(msg, thinkingBlocks, protocol) {
  if (protocol === "anthropic") {
    if (typeof msg.content === "string") {
      var arr = thinkingBlocks.slice();
      arr.push({ type: "text", text: msg.content });
      msg.content = arr;
    } else if (Array.isArray(msg.content)) {
      // Prepend blocks that aren't already present (dedup by text match)
      for (var b = thinkingBlocks.length - 1; b >= 0; b--) {
        var block = thinkingBlocks[b];
        var dup = msg.content.some(function (existing) {
          return existing.type === "thinking" && existing.thinking === block.thinking;
        });
        if (!dup) {
          msg.content.unshift(block);
        }
      }
    }
  } else {
    // openai-chat protocol: append reasoning_content
    for (var i = 0; i < thinkingBlocks.length; i++) {
      msg.reasoning_content = (msg.reasoning_content || "") + thinkingBlocks[i].thinking;
    }
  }
}

function dumpThinkingBlocks(messages, provider) {
  var lines = [];
  for (var m = 0; m < messages.length; m++) {
    var msg = messages[m];
    if (msg.role !== "assistant") continue;
    var content = msg.content;
    if (typeof content === "string") {
      lines.push("  msg[" + m + "] assistant text(" + content.length + ")");
      continue;
    }
    if (!Array.isArray(content)) {
      lines.push("  msg[" + m + "] assistant <no content>");
      continue;
    }
    var blocks = content.map(function (b) {
      if (b.type === "thinking") {
        var txt = (b.thinking || "");
        var prefix = txt.length > 60 ? txt.slice(0, 60) + "..." : txt;
        return "thinking(len=" + txt.length + ",sig=" + (b.signature ? "yes" : "NO") + ") " + prefix;
      }
      if (b.type === "text") {
        return "text(" + (b.text ? b.text.length : 0) + ")";
      }
      if (b.type === "tool_use") return "tool_use(" + (b.name || "?") + ")";
      if (b.type === "tool_result") return "tool_result";
      return b.type || "?";
    });
    lines.push("  msg[" + m + "] assistant: [" + blocks.join(", ") + "]");
  }
  log.debug(
    "[deepseek] thinking dump (" + messages.length + " msgs):\n" + lines.join("\n"),
    { provider: provider.name }
  );
}

function dumpInputStructure(inputItems, messages, provider) {
  var parts = [];
  for (var i = 0; i < inputItems.length; i++) {
    var it = inputItems[i];
    if (!it || typeof it !== "object") {
      parts.push("[" + i + "] " + typeof it);
      continue;
    }
    var type = it.type || (it.role ? "role:" + it.role : "?");
    var extra = "";
    if (it.type === "reasoning") {
      var summaries = Array.isArray(it.summary) ? it.summary : (it.summary ? [it.summary] : []);
      var lens = summaries.map(function (s) { return (s.text || "").length; }).join(",");
      extra = " summaries=" + summaries.length + " lens=[" + lens + "]";
    } else if (it.type === "function_call") {
      extra = " name=" + (it.name || "?") + " call_id=" + (it.call_id || it.id || "?");
    } else if (it.type === "function_call_output") {
      extra = " call_id=" + (it.call_id || it.id || "?");
    } else if (it.role || it.type === "message") {
      extra = " role=" + (it.role || "?");
    }
    parts.push("[" + i + "] " + type + extra);
  }
  log.debug(
    "[deepseek] input dump (" + inputItems.length + " items → " + messages.length +
    " msgs, protocol=" + provider.protocol + "):\n  " + parts.join("\n  "),
    { provider: provider.name }
  );
}

module.exports = { onMessagesBuilt };
