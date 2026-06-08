// A cheap, provider-agnostic token estimate for the messages we're ABOUT to send.
// The live context gauge keys off the previous turn's reported usage, so a large
// input added on the current turn (a fetched page, a big pasted file, a verbose
// tool result) isn't reflected until after the request — too late. Estimating
// here lets the loop compact (or stop) before sending a prompt that overflows the
// model's context window. ~4 chars/token is the standard rough heuristic for
// English + code; we only need to be right enough to catch genuine overflow, not
// to bill against it.
import type { ChatMessage } from "../providers/types";

const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 4; // role + delimiters the provider adds around each message
const PER_IMAGE_TOKENS = 1_000; // rough fixed allowance per attached image

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate the total tokens of a request: the system prompt plus every message
 *  (content, tool-call arguments, and a flat allowance per image). */
export function estimateMessagesTokens(messages: ChatMessage[], system?: string): number {
  let total = system ? estimateTokens(system) : 0;
  for (const m of messages) {
    total += PER_MESSAGE_OVERHEAD;
    total += estimateTokens(m.content);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += estimateTokens(tc.name);
        total += estimateTokens(JSON.stringify(tc.arguments ?? {}));
      }
    }
    if (m.images) total += m.images.length * PER_IMAGE_TOKENS;
  }
  return total;
}
