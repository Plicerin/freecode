// Anthropic and Gemini carry truncation + final output-token counts in places the
// stream handlers were missing (Anthropic: top-level usage + delta.stop_reason on
// message_delta; Gemini: candidate.finishReason). The bug: output tokens went
// uncounted (cost undercounted on the flagship provider) and MAX_TOKENS was reported
// as a clean end_turn, so the loop's auto-continue-on-truncation heal never fired.
import { test, expect, describe, afterEach } from "bun:test";
import { AnthropicProvider } from "../src/providers/anthropic";
import { GeminiProvider } from "../src/providers/gemini";
import type { StreamEvent, ChatRequest } from "../src/providers/types";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function sse(objs: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) { for (const o of objs) c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const req = (model: string) => ({ model, messages: [{ role: "user", content: "hi" }] }) as unknown as ChatRequest;

describe("Anthropic stream: output tokens + truncation", () => {
  test("message_delta usage/stop_reason are read → output counted, max_tokens surfaced", async () => {
    globalThis.fetch = (async () => sse([
      { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 842 } },
      { type: "message_stop" },
    ])) as unknown as typeof fetch;
    const events = await collect(new AnthropicProvider({ apiKey: "test" }).stream(req("claude-x")));
    expect(events.some((e) => e.type === "usage" && e.usage.output === 842)).toBe(true);
    const end = events.find((e) => e.type === "end");
    expect(end && end.type === "end" && end.reason).toBe("max_tokens");
  });

  test("a normal stop is still end_turn", async () => {
    globalThis.fetch = (async () => sse([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ])) as unknown as typeof fetch;
    const events = await collect(new AnthropicProvider({ apiKey: "test" }).stream(req("claude-x")));
    const end = events.find((e) => e.type === "end");
    expect(end && end.type === "end" && end.reason).toBe("end_turn");
  });
});

describe("Gemini stream: truncation", () => {
  test("finishReason MAX_TOKENS → end reason max_tokens", async () => {
    globalThis.fetch = (async () => sse([
      { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    ])) as unknown as typeof fetch;
    const events = await collect(new GeminiProvider({ apiKey: "test" }).stream(req("gemini-x")));
    const end = events.find((e) => e.type === "end");
    expect(end && end.type === "end" && end.reason).toBe("max_tokens");
  });

  test("finishReason STOP → end_turn", async () => {
    globalThis.fetch = (async () => sse([
      { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] },
    ])) as unknown as typeof fetch;
    const events = await collect(new GeminiProvider({ apiKey: "test" }).stream(req("gemini-x")));
    const end = events.find((e) => e.type === "end");
    expect(end && end.type === "end" && end.reason).toBe("end_turn");
  });
});
