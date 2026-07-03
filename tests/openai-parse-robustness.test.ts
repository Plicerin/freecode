// Robustness of the OpenAI-compat stream parser against the sloppier things
// local servers (llama.cpp / Ollama builds) actually do: omit the tool-call
// `id`, omit the `index`, stream an error object mid-body, or close the stream
// after a final line with no trailing newline / `[DONE]`.
import { test, expect, describe, afterEach } from "bun:test";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import type { ChatRequest, StreamEvent, ToolCall } from "../src/providers/types";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(sse: string): void {
  globalThis.fetch = (async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

const provider = new OpenAICompatProvider("ollama", "Ollama", {
  apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", providerName: "Ollama", defaultModel: "m", authHeader: "none",
});

async function drain(): Promise<StreamEvent[]> {
  const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "x" }] };
  const out: StreamEvent[] = [];
  for await (const e of provider.stream(req)) out.push(e);
  return out;
}
const calls = (evs: StreamEvent[]): ToolCall[] => evs.filter((e) => e.type === "tool_call").map((e) => (e as { call: ToolCall }).call);
const chunk = (delta: unknown, finish?: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;

describe("openai-compat parse robustness", () => {
  test("emits a tool call even when the server omits the id (synthesizes one)", async () => {
    stubFetch(chunk({ tool_calls: [{ index: 0, function: { name: "Grep", arguments: '{"pattern":"X"}' } }] }, "tool_calls") + "data: [DONE]\n\n");
    const c = calls(await drain());
    expect(c).toHaveLength(1);
    expect(c[0]!.name).toBe("Grep");
    expect(c[0]!.arguments).toEqual({ pattern: "X" });
    expect(c[0]!.id).toBeTruthy(); // synthesized, not dropped
  });

  test("keeps parallel tool calls distinct when the server omits index (keys by id)", async () => {
    stubFetch(
      chunk({ tool_calls: [{ id: "a", function: { name: "Read", arguments: '{"path":"a"}' } }] }) +
      chunk({ tool_calls: [{ id: "b", function: { name: "Read", arguments: '{"path":"b"}' } }] }, "tool_calls") +
      "data: [DONE]\n\n",
    );
    const c = calls(await drain());
    expect(c).toHaveLength(2); // NOT merged into one with concatenated args
    expect(c.map((x) => x.arguments)).toEqual([{ path: "a" }, { path: "b" }]);
    expect(c.map((x) => x.id)).toEqual(["a", "b"]);
  });

  test("surfaces a mid-stream error object instead of swallowing it", async () => {
    stubFetch(chunk({ content: "partial" }) + `data: ${JSON.stringify({ error: { message: "quota exceeded" } })}\n\n`);
    const evs = await drain();
    const err = evs.find((e) => e.type === "error") as { error?: { message?: string } } | undefined;
    expect(err).toBeDefined();
    expect(err!.error!.message).toMatch(/quota exceeded/);
  });

  test("recovers the final tool call stranded when the stream ends with no newline / [DONE]", async () => {
    // No trailing "\n\n", no [DONE] — the last line sits in the buffer at EOF.
    const line = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "Grep", arguments: '{"pattern":"Z"}' } }] }, finish_reason: "tool_calls" }] })}`;
    stubFetch(line); // note: deliberately no terminating newline
    const evs = await drain();
    const c = calls(evs);
    expect(c).toHaveLength(1);
    expect(c[0]!.arguments).toEqual({ pattern: "Z" });
    expect((evs.find((e) => e.type === "end") as { reason?: string } | undefined)?.reason).toBe("tool_use");
  });
});
