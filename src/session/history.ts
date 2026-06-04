import type { ChatMessage } from "../providers/types";

/**
 * Rebuild a conversation history from persisted session events so a resumed
 * session keeps its context. Text-only (user/assistant) — tool_use/tool_result
 * pairing isn't reconstructed, which keeps the provider message format valid.
 */
export function historyFromEvents(events: Array<{ kind: string; text?: string }>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of events) {
    if (e.kind === "user" && e.text) out.push({ role: "user", content: e.text });
    else if (e.kind === "assistant" && e.text) out.push({ role: "assistant", content: e.text });
  }
  return out;
}
