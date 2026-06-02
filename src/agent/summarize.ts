import type { Provider, ChatMessage } from "../providers/types";

const SYSTEM = "You compress conversations. Produce a concise summary of the conversation below, preserving key facts, decisions, file paths, command results, and any unfinished tasks. Output only the summary text.";

/** Ask the provider for a concise summary of the given messages. */
export async function summarizeConversation(
  provider: Provider,
  model: string,
  msgs: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let text = "";
  for await (const e of provider.stream({
    model,
    system: SYSTEM,
    messages: [...msgs, { role: "user", content: "Summarize everything above concisely." }],
    stream: true,
    maxTokens: 1024,
    signal,
  })) {
    if (e.type === "text_delta") text += e.delta;
  }
  return text.trim();
}
