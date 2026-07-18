// Tool-call enforcement (Layer 1): the loop can compel a tool call by setting
// ChatRequest.toolChoice, which the OpenAI-compat provider forwards as
// `tool_choice`. It MUST only be sent when the caller asks AND tools are present,
// so a normal turn (model free to answer in text) is never accidentally forced.
import { test, expect, describe, afterEach } from "bun:test";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import type { ChatRequest } from "../src/providers/types";
import { z } from "zod";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stub fetch, capture the request body, return a trivial (empty) SSE stream. */
function captureBody(): () => Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? "{}");
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return () => captured;
}

const provider = new OpenAICompatProvider("llama-server", "llama.cpp", {
  apiKey: "", baseUrl: "http://127.0.0.1:8080/v1", providerName: "llama-server", defaultModel: "m", authHeader: "none",
});
const tools = [{ name: "Grep", description: "search", schema: z.object({ pattern: z.string().min(1) }) }];

async function send(req: Partial<ChatRequest>): Promise<void> {
  const full: ChatRequest = { model: "m", messages: [{ role: "user", content: "x" }], ...req };
  for await (const _ of provider.stream(full)) { /* drain */ }
}

describe("tool_choice enforcement", () => {
  test("forwards toolChoice:'required' as tool_choice when tools are present", async () => {
    const body = captureBody();
    await send({ tools, toolChoice: "required" });
    expect(body().tool_choice).toBe("required");
  });

  test("omits tool_choice entirely on a normal turn (no toolChoice set)", async () => {
    const body = captureBody();
    await send({ tools });
    expect("tool_choice" in body()).toBe(false);
  });

  test("does not send tool_choice when there are no tools to choose from", async () => {
    const body = captureBody();
    await send({ toolChoice: "required" }); // no tools
    expect("tool_choice" in body()).toBe(false);
  });
});
