import type { ChatMessage } from "../providers/types";

// Every provider (OpenAI, Anthropic, Gemini) enforces the same invariant: an
// assistant message that makes tool calls MUST be followed by a tool result for
// each call id, and a tool result with no matching call is illegal. Two things
// in a long session quietly break this and then poison EVERY later request:
//
//   1. Interrupting (esc) a multi-tool turn before all calls have run, leaving
//      the trailing calls unanswered.
//   2. Auto-compaction splicing out older messages and cutting between a call
//      and its result.
//
// The OpenAI surface reports it as: "An assistant message with 'tool_calls'
// must be followed by tool messages responding to each 'tool_call_id'."
//
// This normalizes a message list so the pairing always holds — backfilling a
// synthetic result for any unanswered call, and dropping orphan tool messages
// whose call is gone. It's pure and idempotent: a well-formed list is unchanged.
export function sanitizeToolPairing(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      out.push(m);
      const wanted = new Set(m.toolCalls.map((c) => c.id));
      const answered = new Set<string>();
      // Consume the contiguous run of tool messages that should answer this call.
      let j = i + 1;
      for (; j < messages.length && messages[j]!.role === "tool"; j++) {
        const tm = messages[j]!;
        if (tm.toolCallId && wanted.has(tm.toolCallId) && !answered.has(tm.toolCallId)) {
          answered.add(tm.toolCallId);
          out.push(tm);
        }
        // else: orphan id, duplicate, or missing id → drop it
      }
      // Backfill any call that never got a result, so the block is complete.
      for (const c of m.toolCalls) {
        if (!answered.has(c.id)) {
          out.push({
            role: "tool",
            toolCallId: c.id,
            content: "[no result — the tool call was interrupted or dropped from context]",
          });
        }
      }
      i = j - 1; // continue after the tool run we just consumed
    } else if (m.role === "tool") {
      // A tool message not attached to a preceding assistant tool_call block is
      // an orphan (e.g. compaction removed its assistant message) → drop it.
      continue;
    } else {
      out.push(m);
    }
  }
  return out;
}
