// Some models emit tool calls in their TEXT (XML/markup they were trained on)
// instead of the structured tool_calls the API expects — and when the provider
// (notably LM Studio with certain local models) doesn't parse that format, the
// markup leaks into the content. freecode then sees text, not a tool call, and
// can't act. Detect that leakage so the turn-end signal can name it precisely.
import type { StreamEvent } from "../providers/types";

const MARKERS: RegExp[] = [
  /<function[_-]?calls?\b/i, // <function_calls> / <function-calls>
  /<tool_call\b/i, // a common tool-call wrapper (textual, late X7 call)
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
  if (/[:]\s*$/.test(t)) return true; // ended on a bare colon — was about to continue/list/act
  return INTENT_RE.test(t.slice(-240)); // a trailing "next I'll check X"
}

// ─────────────────────────────────────────────────────────────────────────────
// Text tool-call PARSING (the root fix). Some models — and some servers that only
// half-apply a model's chat template (llama.cpp + Qwen without a matching --jinja
// template is the observed case) — put tool-call MARKUP in the assistant CONTENT
// instead of a structured tool_call. Two shapes show up:
//   1. the WHOLE call leaks as text (no structured call is made), e.g.
//        <tool_call><function=Glob><parameter=pattern>**/*.js</parameter></function></tool_call>
//   2. the server parses the opener into a real call but LEAVES the closing tags
//      in content (the reported case: only </parameter></function></tool_call> show).
// We parse (1) into real calls and strip (2)'s residue, so the model "just works"
// and no markup leaks into the transcript. Conservative: a block is only turned
// into a call when its name is a KNOWN tool (so prose/code that merely mentions the
// format is never executed), and this runs ONLY for providers whose servers don't
// reliably emit structured calls (see shouldParseTextToolCalls).

export interface ParsedTextToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// A raw <parameter> value is text; coerce to JSON when it clearly is one (number,
// bool, null, array, object, quoted string) so typed tool args survive. Strips a
// single template newline from each side (the chat template's own formatting).
function coerceParamValue(raw: string): unknown {
  const v = raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  const t = v.trim();
  if (t && /^(-?\d|true\b|false\b|null\b|\[|\{|")/.test(t)) {
    try { return JSON.parse(t); } catch { /* not JSON after all — keep the string */ }
  }
  return v;
}

function extractParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { if (!(k in args)) args[k] = v; };
  let m: RegExpExecArray | null;
  // <parameter=KEY>VALUE</parameter>            (Qwen "=" style)
  const eq = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter>/gi;
  while ((m = eq.exec(body))) set(m[1]!, coerceParamValue(m[2]!));
  // <parameter name="KEY">VALUE</parameter>      (Anthropic "name" + inner text)
  const named = /<parameter\s+name\s*=\s*["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\/parameter>/gi;
  while ((m = named.exec(body))) set(m[1]!, coerceParamValue(m[2]!));
  // <parameter name="KEY" value="VALUE" …>       (Anthropic value-attribute form)
  const valAttr = /<parameter\s+name\s*=\s*["']?([^"'>\s]+)["']?[^>]*?\svalue\s*=\s*"([^"]*)"[^>]*>/gi;
  while ((m = valAttr.exec(body))) set(m[1]!, coerceParamValue(m[2]!));
  return args;
}

function callFromBlock(block: string): ParsedTextToolCall | null {
  // <function=NAME> … </function>  (Qwen, incl. when wrapped in <tool_call>)
  const fn = block.match(/<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function>/i);
  if (fn) return { name: fn[1]!, arguments: extractParameters(fn[2]!) };
  // <invoke name="NAME"> … </invoke>  (Anthropic XML)
  const inv = block.match(/<invoke\b[^>]*\bname\s*=\s*["']?([^"'>\s]+)["']?[^>]*>([\s\S]*?)<\/invoke>/i);
  if (inv) return { name: inv[1]!, arguments: extractParameters(inv[2]!) };
  // <tool_call>{"name":"NAME","arguments":{…}}</tool_call>  (Hermes / JSON)
  const js = block.match(/\{[\s\S]*\}/);
  if (js) {
    try {
      const o = JSON.parse(js[0]) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof o.name === "string") {
        const a = o.arguments ?? o.parameters ?? {};
        return { name: o.name, arguments: a && typeof a === "object" ? (a as Record<string, unknown>) : {} };
      }
    } catch { /* not JSON */ }
  }
  return null;
}

// Complete opener→closer blocks. tool_call FIRST so a Qwen wrapper is taken whole.
const TOOL_BLOCK_RE = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>|<function_calls\b[^>]*>[\s\S]*?<\/function_calls>|<invoke\b[^>]*>[\s\S]*?<\/invoke>|<function\s*=\s*[^>\s]+\s*>[\s\S]*?<\/function>/gi;
// Residue closers a server leaves after parsing the opener itself (case 2). Eats a
// leading blank so stripping doesn't leave an empty line behind.
const STRAY_CLOSER_RE = /[ \t]*\r?\n?[ \t]*<\/(?:tool_call|function_calls|function|parameter|invoke)\s*>/gi;

/** Parse text-form tool calls out of a COMPLETE text blob. Returns the calls and
 *  the text with their markup (and any stray closing tags) removed. A block whose
 *  tool name isn't in `known` (when given) is left untouched, never executed. */
export function parseTextToolCalls(text: string, known?: Set<string>): { calls: ParsedTextToolCall[]; cleaned: string } {
  const calls: ParsedTextToolCall[] = [];
  let cleaned = text.replace(TOOL_BLOCK_RE, (block) => {
    const call = callFromBlock(block);
    if (call && (!known || known.has(call.name))) { calls.push(call); return ""; }
    return block; // unknown tool or unparseable — leave as-is (lets the warning still fire)
  });
  // Strip ORPHANED closing tags (server parsed the opener but leaked the closers) —
  // but only when no opener remains, so an intact/unknown block we deliberately kept
  // in place isn't mangled by having its own closers removed.
  if (!/<tool_call\b|<function_calls\b|<invoke\b|<function\s*=/i.test(cleaned)) {
    cleaned = cleaned.replace(STRAY_CLOSER_RE, "");
  }
  return { calls, cleaned };
}

function argKey(name: string, args: Record<string, unknown>): string {
  let a = "";
  try { a = JSON.stringify(args, Object.keys(args).sort()); } catch { a = ""; }
  return name + " " + a;
}

// Longest trailing run that might be the START of a tool tag split across deltas —
// held back until the next chunk (or flush) so we never emit half a tag.
function heldTailLength(buf: string): number {
  const lt = buf.lastIndexOf("<");
  if (lt === -1 || buf.indexOf(">", lt) !== -1) return 0; // no open tag at the tail
  const tail = buf.slice(lt).toLowerCase();
  const STARTS = ["<tool_call", "<function_calls", "<function=", "<function", "<invoke", "</tool_call", "</function_calls", "</function", "</parameter", "</invoke", "</"];
  return STARTS.some((s) => s.startsWith(tail) || tail.startsWith(s)) ? buf.length - lt : 0;
}

type NextTok = { index: number; length: number; closer: string | null };
function nextToolToken(buf: string): NextTok | null {
  const re = /<tool_call\b[^>]*>|<function_calls\b[^>]*>|<invoke\b[^>]*>|<function\s*=\s*[^>\s]+\s*>|<\/(?:tool_call|function_calls|function|parameter|invoke)\s*>/gi;
  const m = re.exec(buf);
  if (!m) return null;
  const low = m[0].toLowerCase();
  if (low.startsWith("</")) return { index: m.index, length: m[0].length, closer: null }; // stray closer
  const closer =
    low.startsWith("<tool_call") ? "</tool_call>" :
    low.startsWith("<function_calls") ? "</function_calls>" :
    low.startsWith("<invoke") ? "</invoke>" : "</function>";
  return { index: m.index, length: m[0].length, closer };
}

/** Wrap a provider stream, converting text-form tool calls in the CONTENT channel
 *  into structured `tool_call` events and stripping the markup (incl. stray closing
 *  tags) from the visible text — in real time, across delta boundaries. Non-text
 *  events pass through; a structured tool_call the provider already emitted is
 *  de-duplicated against a parsed twin so a half-parsing server can't double-run. */
export async function* filterTextToolCalls(
  src: AsyncIterable<StreamEvent>,
  known?: Set<string>,
): AsyncIterable<StreamEvent> {
  let buf = "";
  let counter = 0;
  const structuredKeys = new Set<string>(); // name+args the provider emitted as STRUCTURED calls
  const emitCall = function* (c: ParsedTextToolCall): Generator<StreamEvent> {
    // Skip a parsed call ONLY when the provider also emitted it structurally (a
    // half-parsing server that leaks the full block AND makes the call). Never drop
    // structured calls themselves — a model may legitimately repeat name+args (a
    // parallel batch with distinct ids).
    if (structuredKeys.has(argKey(c.name, c.arguments))) return;
    yield { type: "tool_call", call: { id: `text-${++counter}-${c.name}`, name: c.name, arguments: c.arguments } };
  };
  const drain = function* (final: boolean): Generator<StreamEvent> {
    for (;;) {
      const tok = nextToolToken(buf);
      if (!tok) {
        const keep = final ? 0 : heldTailLength(buf);
        const out = buf.slice(0, buf.length - keep);
        if (out) yield { type: "text_delta", delta: out };
        buf = buf.slice(buf.length - keep);
        return;
      }
      if (tok.index > 0) {
        const pre = buf.slice(0, tok.index);
        // Before a stray closer, drop trailing blank space so no empty line is left.
        yield { type: "text_delta", delta: tok.closer === null ? pre.replace(/[ \t]*\r?\n?[ \t]*$/, "") : pre };
      }
      buf = buf.slice(tok.index);
      if (tok.closer === null) { // stray closing tag → strip it and a trailing newline
        buf = buf.slice(tok.length).replace(/^[ \t]*\r?\n?/, "");
        continue;
      }
      const closeAt = buf.toLowerCase().indexOf(tok.closer, tok.length);
      if (closeAt === -1) {
        if (!final) return; // block still streaming — wait for its closer
        const { calls, cleaned } = parseTextToolCalls(buf, known);
        for (const c of calls) yield* emitCall(c);
        if (cleaned) yield { type: "text_delta", delta: cleaned };
        buf = "";
        return;
      }
      const end = closeAt + tok.closer.length;
      const block = buf.slice(0, end);
      const { calls, cleaned } = parseTextToolCalls(block, known);
      if (calls.length) {
        for (const c of calls) yield* emitCall(c);
        if (cleaned.trim()) yield { type: "text_delta", delta: cleaned };
      } else {
        yield { type: "text_delta", delta: block }; // not a known call — don't swallow it
      }
      buf = buf.slice(end);
    }
  };
  for await (const e of src) {
    if (e.type === "text_delta") { buf += e.delta; yield* drain(false); continue; }
    if (e.type === "tool_call") {
      yield* drain(false); // keep ordering: emit committed text before the call
      structuredKeys.add(argKey(e.call.name, e.call.arguments)); // remember it to dedup a parsed twin
      yield e; // always pass a structured call through (distinct ids may repeat args)
      continue;
    }
    if (e.type === "end" || e.type === "error") { yield* drain(true); yield e; continue; }
    yield e; // thinking_delta, usage
  }
  yield* drain(true); // stream ended without an explicit end event
}

const NATIVE_STRUCTURED_TOOL_PROVIDERS = new Set(["anthropic", "openai", "gemini", "bedrock", "vertex"]);

/** Whether to run the text tool-call parser for a provider. ON for local/aggregator
 *  servers that may not emit structured calls (llama.cpp/Ollama/LM Studio, OpenRouter,
 *  etc.); OFF for providers with reliable native tool calls, so a model that merely
 *  PRINTS tool-call markup can't be turned into an accidental call. Override with
 *  FREECODE_PARSE_TEXT_TOOL_CALLS=1|0. */
export function shouldParseTextToolCalls(providerId: string, override?: string): boolean {
  const f = (override || "").toLowerCase();
  if (f === "1" || f === "true") return true;
  if (f === "0" || f === "false") return false;
  return !NATIVE_STRUCTURED_TOOL_PROVIDERS.has(providerId);
}
