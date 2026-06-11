// Some models emit tool calls in their TEXT (XML/markup they were trained on)
// instead of the structured tool_calls the API expects — and when the provider
// (notably LM Studio with certain local models) doesn't parse that format, the
// markup leaks into the content. freecode then sees text, not a tool call, and
// can't act. Detect that leakage so the turn-end signal can name it precisely.

const MARKERS: RegExp[] = [
  /<function[_-]?calls?\b/i, // <function_calls> / <function-calls>
  /<tool_call\b/i, // <tool_call>
  /<invoke\b/i, // <invoke name="...">
  /<function\s*=/i, // <function=Bash>
  /<parameter\s+name\s*=/i, // <parameter name="..." value="...">
  /<\|tool_call\|>|<\|tool\|>/i, // special-token tool markers
];

/** True when the text contains tool-call markup the provider failed to parse
 *  into a structured call (so it arrived as content instead). */
export function looksLikeTextToolCall(text: string): boolean {
  if (!text) return false;
  return MARKERS.some((re) => re.test(text));
}

// A weaker model often ANNOUNCES its next step in prose ("I'll check the contents
// of …", "Let me look at …", "Next, I'll run …") and then ends its turn WITHOUT
// emitting the tool call. The loop would read "no tool call" as "done" and hand
// control back — the "stops mid-task, needs 'continue continue'" failure. Detect
// the announcement so the loop can nudge it to ACT instead of surrendering the
// turn. Conservative, and harmless on a false positive (the nudge just asks an
// already-finished model to confirm it's done).
const ACTION_VERB =
  "check|look|read|run|search|grep|glob|find|open|inspect|examine|view|list|explore|verify|test|build|compile|create|write|edit|update|modify|fix|add|implement|install|continue|proceed|start|investigate|review|analy[sz]e|trace|navigate|cd|move|go";
const INTENT_RE = new RegExp(
  `\\b(i'?ll|i\\s+will|i'?m\\s+going\\s+to|going\\s+to|let\\s+me|let'?s|next,?\\s+i|now\\s+i'?ll?|i\\s+need\\s+to|i\\s+should|let\\s+me\\s+now)\\b[^.!?\\n]*\\b(${ACTION_VERB})\\b`,
  "i",
);

/** True when the model's turn text announces a next action it didn't actually
 *  take (no tool call) — so the loop should nudge it to continue, not stop. */
export function announcedNextActionWithoutCalling(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[:]\s*$/.test(t)) return true; // ended on a bare colon → was about to continue/list/act
  return INTENT_RE.test(t.slice(-240)); // "…next I'll check X" near the end
}
