// gpt-oss (and other open reasoning models) are reasoning models: freecode must
// (1) send a reasoning_effort so they actually think during agentic work, and
// (2) surface their separate reasoning channel instead of dropping it.
import { test, expect, describe, afterEach } from "bun:test";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import type { ChatRequest, StreamEvent } from "../src/providers/types";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; delete process.env.FREECODE_REASONING_EFFORT; });

// Capture the request body, and stream back a canned SSE response.
function stubFetch(sse: string): () => Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body);
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return () => captured;
}

const provider = new OpenAICompatProvider("nim", "NVIDIA NIM", {
  apiKey: "k", baseUrl: "https://example.com/v1", providerName: "nim", defaultModel: "openai/gpt-oss-120b",
});

async function drain(req: ChatRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of provider.stream(req)) out.push(e);
  return out;
}

describe("reasoning_effort (opt-in)", () => {
  test("a gpt-oss model sends NO reasoning_effort by default (prior behavior, temp 0.7)", async () => {
    const body = stubFetch('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    await drain({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "x" }], stream: true });
    expect(body().reasoning_effort).toBeUndefined();
    expect(body().temperature).toBe(0.7);
  });

  test("FREECODE_REASONING_EFFORT opts in for reasoning models (and bumps temp to 1)", async () => {
    process.env.FREECODE_REASONING_EFFORT = "high";
    const body = stubFetch('data: [DONE]\n\n');
    await drain({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "x" }], stream: true });
    expect(body().reasoning_effort).toBe("high");
    expect(body().temperature).toBe(1);
  });

  test("the env var does nothing for a non-reasoning model", async () => {
    process.env.FREECODE_REASONING_EFFORT = "high";
    const body = stubFetch('data: [DONE]\n\n');
    await drain({ model: "meta/llama-3.1-70b", messages: [{ role: "user", content: "x" }], stream: true });
    expect(body().reasoning_effort).toBeUndefined();
    expect(body().temperature).toBe(0.7);
  });
});

describe("finish_reason → end reason", () => {
  test("length (truncated) maps to max_tokens so the loop can flag it", async () => {
    stubFetch('data: {"choices":[{"delta":{"content":"cut o"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
    const events = await drain({ model: "m", messages: [{ role: "user", content: "x" }], stream: true });
    const end = events.find((e) => e.type === "end") as { reason?: string } | undefined;
    expect(end?.reason).toBe("max_tokens");
  });

  test("stop maps to end_turn", async () => {
    stubFetch('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const events = await drain({ model: "m", messages: [{ role: "user", content: "x" }], stream: true });
    const end = events.find((e) => e.type === "end") as { reason?: string } | undefined;
    expect(end?.reason).toBe("end_turn");
  });
});

describe("reasoning channel", () => {
  test("reasoning_content is surfaced as thinking_delta, kept out of the answer", async () => {
    stubFetch(
      'data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"the answer"}}]}\n\n' +
      "data: [DONE]\n\n",
    );
    const events = await drain({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "x" }], stream: true });
    const thinking = events.filter((e) => e.type === "thinking_delta").map((e) => (e as { delta: string }).delta);
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta);
    expect(thinking).toEqual(["let me think"]);
    expect(text).toEqual(["the answer"]);
  });
});
