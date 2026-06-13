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

// Yield every TOP-LEVEL balanced { … } object in the text (string/escape aware),
// so we can scan content for an embedded tool-call JSON without a brittle regex.
function* jsonObjectCandidates(text: string): Generator<string> {
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      if (depth > 0) { depth--; if (depth === 0 && start >= 0) { yield text.slice(start, i + 1); start = -1; } }
    }
  }
}

const NAME_KEYS = ["name", "tool", "function", "tool_name"];
const ARG_KEYS = ["arguments", "parameters", "args", "input", "tool_input"];

/** Recover a tool call a model emitted as JSON TEXT in its content (e.g.
 *  `{"name":"Bash","arguments":{…}}`, with or without a <tool_call> wrapper or
 *  ```json fence) when the provider returned NO structured tool_calls — a common
 *  failure with local servers whose chat template doesn't wrap tool calls.
 *  Conservative on purpose: only fires when the JSON names a REGISTERED tool, so
 *  example/config JSON in prose can't be mistaken for a call. Returns the first
 *  match, or null. The caller routes it through the normal permission + schema
 *  path, and surfaces that a text call was recovered (never silent). */
export function recoverTextToolCall(
  text: string,
  toolNames: readonly string[],
): { name: string; arguments: Record<string, unknown> } | null {
  if (!text) return null;
  const known = new Set(toolNames);
  for (const candidate of jsonObjectCandidates(text)) {
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const nameKey = NAME_KEYS.find((k) => typeof obj[k] === "string" && known.has(obj[k] as string));
    if (!nameKey) continue;
    const argKey = ARG_KEYS.find((k) => obj[k] !== null && typeof obj[k] === "object" && !Array.isArray(obj[k]));
    return { name: obj[nameKey] as string, arguments: argKey ? (obj[argKey] as Record<string, unknown>) : {} };
  }
  return null;
}
