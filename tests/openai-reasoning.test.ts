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

describe("reasoning_effort", () => {
  test("a gpt-oss model gets reasoning_effort=high and temperature 1 by default", async () => {
    const body = stubFetch('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    await drain({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "x" }], stream: true });
    expect(body().reasoning_effort).toBe("high");
    expect(body().temperature).toBe(1);
  });

  test("FREECODE_REASONING_EFFORT overrides; =off omits it", async () => {
    process.env.FREECODE_REASONING_EFFORT = "medium";
    let body = stubFetch('data: [DONE]\n\n');
    await drain({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "x" }], stream: true });
    expect(body().reasoning_effort).toBe("medium");

    process.env.FREECODE_REASONING_EFFORT = "off";
    body = stubFetch('data: [DONE]\n\n');
    await drain({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "x" }], stream: true });
    expect(body().reasoning_effort).toBeUndefined();
  });

  test("a non-reasoning model gets no reasoning_effort and the 0.7 default temp", async () => {
    const body = stubFetch('data: [DONE]\n\n');
    await drain({ model: "meta/llama-3.1-70b", messages: [{ role: "user", content: "x" }], stream: true });
    expect(body().reasoning_effort).toBeUndefined();
    expect(body().temperature).toBe(0.7);
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
