"use strict";

// ---------------------------------------------------------------------------
// Shared thinking-tag stream parser
// ---------------------------------------------------------------------------
// Detects <thinking>, <think>, <thought>, <reasoning> tags inside
// streaming text content and splits deltas into reasoning (inside tags) vs. text
// (outside). Used by both openai-chat and anthropic adapters for providers that
// inline thinking in the content field rather than using a dedicated
// reasoning_content field (GLM, Qwen, etc.).
//
// Tags are case-insensitive.  Unclosed tags at stream-end are promoted to
// reasoning so the raw tag never leaks into visible text output.

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

// Check if the tail of buf is a prefix of any close-tag variant.  Returns
// the number of chars to keep (the length of the longest matching prefix).
function maybePartialCloseTag(buf, normalized) {
  if (buf.length === 0) return 0;
  const variants = closeTagVariants(normalized);
  const lower = buf.toLowerCase();
  for (const v of variants) {
    const lowerV = v.toLowerCase();
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

  // Flush any remaining buffered content.
  // When inside an unclosed thinking tag, promote the buffered content
  // to reasoning instead of leaking the raw tag into visible text.
  flush() {
    if (this._inTag) {
      // Unclosed tag — promote content to reasoning so the tag never
      // appears in the text output sent to the user.
      const result = { reasoning: this._buf, text: "" };
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
 * Strip inline <thinking>, </think, <thought>, <reasoning> tags from text
 * and return the extracted reasoning separately.  Used in the non-streaming
 * path where the full response text is available.
 *
 * Handles both matched pairs and unclosed tags (the content of an unclosed
 * tag is promoted to reasoning rather than leaking into the visible text).
 * Also cleans up stray closing tags left by nested tag edge cases.
 */
function extractThinkingTags(text) {
  const reasoning = [];

  // Pass 1: extract matched open/close pairs (non-greedy, innermost first)
  const cleaned = text.replace(/<\s*(think(?:ing)?|thought|reasoning)\s*>([\s\S]*?)<\/\s*\1\s*>/gi, function (_match, _tag, inner) {
    if (inner.trim()) reasoning.push(inner.trim());
    return "";
  });

  // Pass 2: promote unclosed tags to reasoning so the raw tag never leaks
  // into visible text.  This handles the case where a model starts a
  // <thinking> block but the response is cut off before the closing tag.
  const afterUnclosed = cleaned.replace(/<\s*(think(?:ing)?|thought|reasoning)\s*>([\s\S]*)$/gi, function (_match, _tag, inner) {
    if (inner.trim()) reasoning.push(inner.trim());
    return "";
  });

  // Pass 3: strip stray closing tags left by nested-tag edge cases
  const finalText = afterUnclosed.replace(/<\/\s*(think(?:ing)?|thought|reasoning)\s*>/gi, "");

  return { text: finalText.trim(), reasoning: reasoning.join("\n\n") };
}

module.exports = {
  ThinkingTagStreamParser,
  extractThinkingTags,
  THINKING_OPEN_RE,
  normalizeTagName,
  closeTagVariants,
  findCloseTag,
  maybePartialCloseTag,
};
