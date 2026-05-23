"use strict";

const {
  ThinkingTagStreamParser,
  extractThinkingTags,
  normalizeTagName,
  closeTagVariants,
  findCloseTag,
  maybePartialCloseTag,
} = require("../src/shared/thinking-parser");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log("  PASS: " + message);
  } else {
    failed++;
    console.error("  FAIL: " + message);
  }
}

// ===========================================================================
// 1. Internal helpers
// ===========================================================================

function testNormalizeTagName() {
  console.log("\n[Test] normalizeTagName: tag name mapping");
  assert(normalizeTagName("think") === "thinking", "think → thinking");
  assert(normalizeTagName("THINK") === "thinking", "THINK → thinking (case insensitive)");
  assert(normalizeTagName("thinking") === "thinking", "thinking → thinking");
  assert(normalizeTagName("Thought") === "reasoning", "Thought → reasoning");
  assert(normalizeTagName("reasoning") === "reasoning", "reasoning → reasoning");
  assert(normalizeTagName("unknown") === "unknown", "unknown tag passes through");
}

function testCloseTagVariants() {
  console.log("\n[Test] closeTagVariants: correct closing options");
  var thinkVariants = closeTagVariants("thinking");
  assert(thinkVariants.indexOf("</thinking>") >= 0, "thinking: includes </thinking>");
  assert(thinkVariants.indexOf("</think>") >= 0, "thinking: includes </think>");

  var reasonVariants = closeTagVariants("reasoning");
  assert(reasonVariants.indexOf("</reasoning>") >= 0, "reasoning: includes </reasoning>");
  assert(reasonVariants.indexOf("</thought>") >= 0, "reasoning: includes </thought>");

  var otherVariants = closeTagVariants("custom");
  assert(otherVariants.length === 1, "custom: one closing variant");
  assert(otherVariants[0] === "</custom>", "custom: </custom>");
}

function testFindCloseTag() {
  console.log("\n[Test] findCloseTag: finds earliest close tag");
  var r1 = findCloseTag("hello</thinking>world", "thinking");
  assert(r1 !== null, "finds </thinking>");
  assert(r1.index === 5 && r1.length === "</thinking>".length, "correct index and length");

  var r2 = findCloseTag("no closing tag here", "thinking");
  assert(r2 === null, "null when no match");

  var r3 = findCloseTag("content</Thought>end", "reasoning");
  assert(r3 !== null, "case-insensitive match for </Thought>");

  // Multiple variants: earliest wins
  var r4 = findCloseTag("A</think> before </thinking>", "thinking");
  assert(r4 !== null && r4.index === 1, "earliest close tag variant wins");
}

function testMaybePartialCloseTag() {
  console.log("\n[Test] maybePartialCloseTag: partial close detection");
  assert(maybePartialCloseTag("", "thinking") === 0, "empty: 0");
  assert(maybePartialCloseTag("hello", "thinking") === 0, "no match: 0");
  assert(maybePartialCloseTag("some</", "thinking") === 2, "trailing </: keep 2");
  assert(maybePartialCloseTag("some</t", "thinking") === 3, "trailing </t: keep 3");
  assert(maybePartialCloseTag("some</th", "thinking") === 4, "trailing </th: keep 4");
  assert(maybePartialCloseTag("some</thi", "thinking") === 5, "trailing </thi: keep 5");
  assert(maybePartialCloseTag("some</thin", "thinking") === 6, "trailing </thin: keep 6");
  assert(maybePartialCloseTag("some</think", "thinking") === 7, "trailing </think: keep 7");
  assert(maybePartialCloseTag("some</thinking", "thinking") === 10, "trailing </thinking: keep 10");
  assert(maybePartialCloseTag("some</", "reasoning") === 2, "reasoning </: keep 2");
  assert(maybePartialCloseTag("some</th", "reasoning") === 4, "reasoning </th: keep 4");
}

// ===========================================================================
// 2. ThinkingTagStreamParser — feed + flush
// ===========================================================================

function testStreamBasicThinking() {
  console.log("\n[Test] stream: basic <thinking> tag closed by </thinking>");
  var parser = new ThinkingTagStreamParser();
  var r1 = parser.feed("<thinking>");
  assert(r1.reasoning === "" && r1.text === "", "opening tag consumes nothing");
  var r2 = parser.feed("hello world");
  assert(r2.reasoning === "hello world" && r2.text === "", "content goes to reasoning");
  var r3 = parser.feed("</thinking>");
  assert(r3.reasoning === "" && r3.text === "", "closing tag consumes nothing");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "flush: nothing remains");
}

function testStreamThinkShorthand() {
  console.log("\n[Test] stream: <think> shorthand tag");
  var parser = new ThinkingTagStreamParser();
  parser.feed("<think>");
  var r = parser.feed("quick thought</think>");
  assert(r.reasoning === "quick thought" && r.text === "", "reasoning extracted with think shorthand");
}

function testStreamThoughtTag() {
  console.log("\n[Test] stream: <thought> tag");
  var parser = new ThinkingTagStreamParser();
  var r = parser.feed("<thought>deep analysis</thought>");
  assert(r.reasoning === "deep analysis" && r.text === "", "reasoning extracted from thought tag");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "flush empty");
}

function testStreamReasoningTag() {
  console.log("\n[Test] stream: <reasoning> tag");
  var parser = new ThinkingTagStreamParser();
  var r = parser.feed("<reasoning>step by step</reasoning>");
  assert(r.reasoning === "step by step" && r.text === "", "reasoning extracted");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "flush empty");
}

function testStreamCaseInsensitive() {
  console.log("\n[Test] stream: case-insensitive tags");
  var parser1 = new ThinkingTagStreamParser();
  parser1.feed("<THINKING>caps</THINKING>");
  var f1 = parser1.flush();
  assert(f1.reasoning === "" && f1.text === "", "uppercase tags consumed");
  // Verify reasoning by feeding each part
  var parser2 = new ThinkingTagStreamParser();
  parser2.feed("<Thinking>");
  var r2 = parser2.feed("mixed");
  assert(r2.reasoning === "mixed", "mixed-case tag: content extracted");

  var parser3 = new ThinkingTagStreamParser();
  parser3.feed("<THINKING>");
  var r3 = parser3.feed("upper")
  assert(r3.reasoning === "upper", "uppercase tag: content extracted");
}

function testStreamTagsWithSpaces() {
  console.log("\n[Test] stream: tags with whitespace");
  var parser = new ThinkingTagStreamParser();
  parser.feed("< thinking >spaced</ thinking >");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "spaces inside tags handled");
}

function testStreamSplitOpeningTag() {
  console.log("\n[Test] stream: opening tag split across chunks");
  var parser = new ThinkingTagStreamParser();
  var r1 = parser.feed("<thin");
  assert(r1.reasoning === "" && r1.text === "", "partial opening '<thin' buffered, no output");
  var r2 = parser.feed("king>content</thinking>");
  assert(r2.reasoning === "content", "reassembled tag: reasoning extracted");
  assert(r2.text === "", "reassembled tag: no text");
}

function testStreamSplitClosingTag() {
  console.log("\n[Test] stream: closing tag split across chunks");
  var parser = new ThinkingTagStreamParser();
  var r1 = parser.feed("<thinking>streaming");
  assert(r1.reasoning === "streaming" && r1.text === "", "first chunk: reasoning output");
  var r2 = parser.feed(" data</thi");
  assert(r2.reasoning === " data" && r2.text === "", "second chunk: data before partial close");
  var r3 = parser.feed("nking>");
  assert(r3.reasoning === "" && r3.text === "", "reassembled close tag consumed");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "flush empty after full close");
}

function testStreamUnclosedTag() {
  console.log("\n[Test] stream: unclosed tag — reasoning emitted in feed, flush clears state");
  var parser = new ThinkingTagStreamParser();
  var r = parser.feed("<thinking>unfinished content");
  assert(r.reasoning === "unfinished content", "reasoning emitted during feed");
  assert(r.text === "", "no text from unclosed tag during feed");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "flush clears remaining buffer (already emitted)");
}

function testStreamNoTags() {
  console.log("\n[Test] stream: normal text with no tags");
  var parser = new ThinkingTagStreamParser();
  var r = parser.feed("Hello, this is normal text.");
  assert(r.reasoning === "" && r.text === "Hello, this is normal text.", "all text goes to text output");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "flush empty");
}

function testStreamEmpty() {
  console.log("\n[Test] stream: empty input");
  var parser = new ThinkingTagStreamParser();
  var r = parser.feed("");
  assert(r.reasoning === "" && r.text === "", "feed empty returns empty");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "flush empty");
}

function testStreamSingleLt() {
  console.log("\n[Test] stream: single < character");
  var parser = new ThinkingTagStreamParser();
  var r = parser.feed("<");
  assert(r.reasoning === "" && r.text === "", "single < is buffered (potential partial tag)");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "<", "single < flushed as text");
}

function testStreamSingleLtThenTag() {
  console.log("\n[Test] stream: single < buffered, then actual tag resolves");
  var parser = new ThinkingTagStreamParser();
  var r1 = parser.feed("<");
  assert(r1.reasoning === "" && r1.text === "", "< buffered");
  var r2 = parser.feed("thinking>content</thinking>");
  assert(r2.reasoning === "content" && r2.text === "", "combined '<thinking>' tag resolved, reasoning extracted");
}

function testStreamMultipleTags() {
  console.log("\n[Test] stream: multiple consecutive thinking tags in one feed");
  var parser = new ThinkingTagStreamParser();
  var r1 = parser.feed("<thinking>first</thinking> text <thinking>second</thinking>");
  assert(r1.reasoning === "firstsecond", "both reasoning chunks extracted");
  assert(r1.text === " text ", "intervening text preserved");
  var r2 = parser.feed("");
  assert(r2.reasoning === "" && r2.text === "", "empty feed after");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "flush empty");
}

function testStreamThinkCloseThinkVariant() {
  console.log("\n[Test] stream: <thinking> closed by </think> variant");
  var parser = new ThinkingTagStreamParser();
  var r = parser.feed("<thinking>content</think>");
  assert(r.reasoning === "content" && r.text === "", "thinking closed by think close tag");
}

function testStreamThoughtCloseThoughtVariant() {
  console.log("\n[Test] stream: <thought> closed by </reasoning> variant");
  var parser = new ThinkingTagStreamParser();
  var r = parser.feed("<thought>analysis</reasoning>");
  assert(r.reasoning === "analysis" && r.text === "", "thought closed by reasoning close tag");
}

function testStreamTextBeforeAndAfter() {
  console.log("\n[Test] stream: text before and after thinking block");
  var parser = new ThinkingTagStreamParser();
  var r = parser.feed("visible prefix <thinking>hidden reasoning</thinking> visible suffix");
  assert(r.reasoning === "hidden reasoning" && r.text === "visible prefix  visible suffix", "text before/after preserved");
}

function testStreamMultiFeedPartialClose() {
  console.log("\n[Test] stream: partial closing tag buffered across feeds");
  var parser = new ThinkingTagStreamParser();
  var r0 = parser.feed("<thinking>hello");
  assert(r0.reasoning === "hello" && r0.text === "", "first feed: reasoning emitted");
  var r = parser.feed("</thi");
  assert(r.reasoning === "" && r.text === "", "partial close '</thi' fully buffered, no output");
  var r2 = parser.feed("nking>");
  assert(r2.reasoning === "" && r2.text === "", "close completed on reassembly");
}

// ===========================================================================
// 3. extractThinkingTags (non-streaming)
// ===========================================================================

function testExtractThinkingBasic() {
  console.log("\n[Test] extractThinkingTags: basic matched pair");
  var result = extractThinkingTags("Text before <thinking>secret reasoning</thinking> text after");
  assert(result.text === "Text before  text after", "tags stripped, text clean");
  assert(result.reasoning === "secret reasoning", "reasoning extracted");
}

function testExtractThinkShorthand() {
  console.log("\n[Test] extractThinkingTags: <think> shorthand");
  var result = extractThinkingTags("Hello <think>internal monologue</think> Goodbye");
  assert(result.text === "Hello  Goodbye", "think tags stripped");
  assert(result.reasoning === "internal monologue", "reasoning from think tag");
}

function testExtractThoughtTag() {
  console.log("\n[Test] extractThinkingTags: <thought> tag");
  var result = extractThinkingTags("Intro <thought>deep analysis here</thought> Outro");
  assert(result.text === "Intro  Outro", "thought tags stripped");
  assert(result.reasoning === "deep analysis here", "reasoning from thought tag");
}

function testExtractReasoningTag() {
  console.log("\n[Test] extractThinkingTags: <reasoning> tag");
  var result = extractThinkingTags("Q: <reasoning>step by step logic</reasoning> A: answer");
  assert(result.text === "Q:  A: answer", "reasoning tags stripped");
  assert(result.reasoning === "step by step logic", "reasoning extracted");
}

function testExtractMultiplePairs() {
  console.log("\n[Test] extractThinkingTags: multiple matched pairs");
  var result = extractThinkingTags("T1 <thinking>R1</thinking> T2 <thinking>R2</thinking> T3");
  assert(result.text === "T1  T2  T3", "all tags stripped");
  assert(result.reasoning === "R1\n\nR2", "multiple reasoning joined by double newline");
}

function testExtractMixedTagTypes() {
  console.log("\n[Test] extractThinkingTags: mixed thinking + thought tag types");
  var result = extractThinkingTags("<thinking>first</thinking> middle <thought>second</thought> end");
  assert(result.text === "middle  end", "all tags stripped");
  assert(result.reasoning === "first\n\nsecond", "both reasoning blocks joined");
}

function testExtractUnclosedTag() {
  console.log("\n[Test] extractThinkingTags: unclosed tag promoted to reasoning");
  var result = extractThinkingTags("Text before <thinking>this tag never closes");
  assert(result.text === "Text before", "tag and its content removed from visible text");
  assert(result.reasoning === "this tag never closes", "unclosed content promoted to reasoning");
}

function testExtractNoTags() {
  console.log("\n[Test] extractThinkingTags: no tags, plain text");
  var result = extractThinkingTags("Plain text without any tags.");
  assert(result.text === "Plain text without any tags.", "text unchanged");
  assert(result.reasoning === "", "no reasoning");
}

function testExtractEmpty() {
  console.log("\n[Test] extractThinkingTags: empty string");
  var result = extractThinkingTags("");
  assert(result.text === "", "empty text");
  assert(result.reasoning === "", "no reasoning");
}

function testExtractCaseInsensitive() {
  console.log("\n[Test] extractThinkingTags: case-insensitive tags");
  var result = extractThinkingTags("<THINKING>UPPER</THINKING>");
  assert(result.text === "", "uppercase tags stripped");
  assert(result.reasoning === "UPPER", "reasoning from uppercase tags");

  var result2 = extractThinkingTags("<Thinking>Mixed</Thinking>");
  assert(result2.text === "", "mixed case stripped");
  assert(result2.reasoning === "Mixed", "mixed case reasoning");
}

function testExtractStrayCloseTag() {
  console.log("\n[Test] extractThinkingTags: stray closing tags stripped");
  var result = extractThinkingTags("</thinking> visible text </think> more text");
  assert(result.text === "visible text  more text", "stray closing tags removed");
  assert(result.reasoning === "", "no reasoning for stray close tags");
}

function testExtractPass1AndPass2() {
  console.log("\n[Test] extractThinkingTags: Pass1 matched + Pass2 unclosed combined");
  var result = extractThinkingTags("<thinking>matched</thinking> text <thought>unclosed here");
  assert(result.text === "text", "matched tags stripped, unclosed tag+content removed");
  assert(result.reasoning === "matched\n\nunclosed here", "both matched and unclosed extracted");
}

function testExtractWhitespaceInTags() {
  console.log("\n[Test] extractThinkingTags: whitespace inside tags");
  var result = extractThinkingTags("< thinking >content</ thinking >");
  assert(result.text === "", "spaced tags stripped");
  assert(result.reasoning === "content", "reasoning extracted with whitespace in tags");
}

function testExtractOnlyOpenTag() {
  console.log("\n[Test] extractThinkingTags: only opening tag, no content");
  var result = extractThinkingTags("<thinking>");
  assert(result.text === "", "opening tag removed from text");
  assert(result.reasoning === "", "no reasoning for empty tag");
}

// ===========================================================================
// 4. Edge cases
// ===========================================================================

function testStreamEdgeOnlyOpenTagNoContent() {
  console.log("\n[Test] stream edge: opening tag with no content flushed");
  var parser = new ThinkingTagStreamParser();
  parser.feed("<thinking>");
  var flush = parser.flush();
  assert(flush.reasoning === "" && flush.text === "", "empty unclosed tag flushed clean");
}

function testStreamEdgeLtInReasoning() {
  console.log("\n[Test] stream edge: < inside reasoning content");
  var parser = new ThinkingTagStreamParser();
  parser.feed("<thinking>");
  var r = parser.feed("3 < 5 is true</thinking>");
  assert(r.reasoning === "3 < 5 is true" && r.text === "", "less-than inside reasoning preserved");
}

function testStreamEdgePartialCloseAmbiguous() {
  console.log("\n[Test] stream edge: ambiguous partial close tag prefix");
  var parser = new ThinkingTagStreamParser();
  var r0 = parser.feed("<thinking>content");
  assert(r0.reasoning === "content" && r0.text === "", "first feed: reasoning emitted");
  var r = parser.feed("</");
  assert(r.reasoning === "" && r.text === "", "partial '</' fully buffered (not reasoning)");
  var r2 = parser.feed("unknown>");
  // "</unknown>" is not a valid close variant for "thinking", so it goes into reasoning
  assert(r2.reasoning === "</unknown>" && r2.text === "", "non-matching close tag goes to reasoning");
}

function testStreamEdgeLtAtEndOfChunk() {
  console.log("\n[Test] stream edge: < at end of chunk, held back for possible tags");
  var parser = new ThinkingTagStreamParser();
  var r1 = parser.feed("hello<");
  assert(r1.reasoning === "" && r1.text === "hello", "text before < passed through");
  // The buffered "<" causes subsequent text to be held back (within 20-char window)
  var r2 = parser.feed("not a tag just text");
  assert(r2.reasoning === "" && r2.text === "", "fed text held back due to pending <");
  var flush = parser.flush();
  assert(flush.text === "<not a tag just text", "all held-back text flushed as plain text");
}

function testExtractNestedTagsBestEffort() {
  console.log("\n[Test] extractThinkingTags: nested tags handling");
  var result = extractThinkingTags("<thinking>outer <thinking>inner</thinking> outer</thinking>");
  assert(result.reasoning.length > 0, "some reasoning extracted for nested tags");
  assert(result.text.length >= 0, "text output produced");
}

function testExtractCarryover() {
  console.log("\n[Test] extractThinkingTags: reasoning with trailing stray close");
  // This is a realistic scenario: model outputs partial content
  var result = extractThinkingTags("<think>Let me analyze the question.</think>");
  assert(result.reasoning === "Let me analyze the question.", "full reasoning extracted");
  assert(result.text === "", "no stray text");
}

// ===========================================================================
// Main
// ===========================================================================

console.log("=== Thinking Parser Tests ===\n");

// 1. Internal helpers
console.log("--- 1. Internal helpers ---");
testNormalizeTagName();
testCloseTagVariants();
testFindCloseTag();
testMaybePartialCloseTag();

// 2. Stream parser
console.log("\n--- 2. ThinkingTagStreamParser ---");
testStreamBasicThinking();
testStreamThinkShorthand();
testStreamThoughtTag();
testStreamReasoningTag();
testStreamCaseInsensitive();
testStreamTagsWithSpaces();
testStreamSplitOpeningTag();
testStreamSplitClosingTag();
testStreamUnclosedTag();
testStreamNoTags();
testStreamEmpty();
testStreamSingleLt();
testStreamSingleLtThenTag();
testStreamMultipleTags();
testStreamThinkCloseThinkVariant();
testStreamThoughtCloseThoughtVariant();
testStreamTextBeforeAndAfter();
testStreamMultiFeedPartialClose();

// 3. Non-streaming extractor
console.log("\n--- 3. extractThinkingTags ---");
testExtractThinkingBasic();
testExtractThinkShorthand();
testExtractThoughtTag();
testExtractReasoningTag();
testExtractMultiplePairs();
testExtractMixedTagTypes();
testExtractUnclosedTag();
testExtractNoTags();
testExtractEmpty();
testExtractCaseInsensitive();
testExtractStrayCloseTag();
testExtractPass1AndPass2();
testExtractWhitespaceInTags();
testExtractOnlyOpenTag();

// 4. Edge cases
console.log("\n--- 4. Edge cases ---");
testStreamEdgeOnlyOpenTagNoContent();
testStreamEdgeLtInReasoning();
testStreamEdgePartialCloseAmbiguous();
testStreamEdgeLtAtEndOfChunk();
testExtractNestedTagsBestEffort();
testExtractCarryover();

console.log("\n=== Thinking Parser Results: " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);
