// A streamed tool call MUST be emitted whether the stream ends with a `[DONE]`
// sentinel OR a clean EOF without one. Some OpenAI-compat servers (notably some
// Ollama builds) just close the stream after the final chunk — flushing only on
// `[DONE]` silently dropped the call, so the model "said it would act" and the
// turn ended with nothing run. This guards both termination paths.
import { test, expect, describe, afterEach } from "bun:test";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import type { ChatRequest, StreamEvent, ToolCall } from "../src/providers/types";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(sse: string): void {
  globalThis.fetch = (async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

const provider = new OpenAICompatProvider("ollama", "Ollama", {
  apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", providerName: "ollama", defaultModel: "gemma", authHeader: "none",
});

async function drain(): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  // Tool calls are parsed from the RESPONSE; the request needn't carry tools.
  const req: ChatRequest = { model: "gemma", stream: true, messages: [{ role: "user", content: "x" }] };
  for await (const e of provider.stream(req)) out.push(e);
  return out;
}

const toolChunk = (args: string, opts?: { id?: string; name?: string; finish?: boolean }): string =>
  JSON.stringify({
    choices: [{
      delta: { tool_calls: [{ index: 0, ...(opts?.id ? { id: opts.id } : {}), function: { ...(opts?.name ? { name: opts.name } : {}), arguments: args } }] },
      ...(opts?.finish ? { finish_reason: "tool_calls" } : {}),
    }],
  });

const toolCalls = (events: StreamEvent[]): ToolCall[] =>
  events.filter((e) => e.type === "tool_call").map((e) => (e as { call: ToolCall }).call);

describe("tool-call flush on stream end", () => {
  test("emits the tool call when the stream ends WITH [DONE] (baseline)", async () => {
    stubFetch(`data: ${toolChunk(JSON.stringify({ pattern: "DRAW" }), { id: "c1", name: "Grep", finish: true })}\n\ndata: [DONE]\n\n`);
    const calls = toolCalls(await drain());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("Grep");
    expect(calls[0]!.arguments).toEqual({ pattern: "DRAW" });
  });

  test("STILL emits the tool call when the stream ends with a clean EOF (no [DONE]) — the bug", async () => {
    stubFetch(`data: ${toolChunk(JSON.stringify({ pattern: "DRAW" }), { id: "c2", name: "Grep", finish: true })}\n\n`);
    const events = await drain();
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toEqual({ pattern: "DRAW" });
    // and the end reason still reflects tool_use
    const end = events.find((e) => e.type === "end") as { reason?: string } | undefined;
    expect(end?.reason).toBe("tool_use");
  });

  test("assembles args split across deltas, then flushes on EOF (no [DONE])", async () => {
    stubFetch(
      `data: ${toolChunk('{"pattern":', { id: "c3", name: "Grep" })}\n\n` +
      `data: ${toolChunk('"X"}', { finish: true })}\n\n`,
    );
    const calls = toolCalls(await drain());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toEqual({ pattern: "X" });
  });

  test("does not double-emit when [DONE] is present", async () => {
    stubFetch(`data: ${toolChunk(JSON.stringify({ pattern: "Y" }), { id: "c4", name: "Grep", finish: true })}\n\ndata: [DONE]\n\n`);
    expect(toolCalls(await drain())).toHaveLength(1); // not 2
  });
});
