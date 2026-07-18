// Learning the real context window from a provider's overflow 400, and the agent
// loop self-healing on it (shrink → compact/trim → retry) instead of dead-ending.
import { test, expect, describe } from "bun:test";
import { parseContextLimit, isContextOverflow } from "../src/agent/context-limit";
import { friendlyError } from "../src/providers/friendly-errors";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent, ChatMessage } from "../src/providers/types";

describe("friendlyError keeps the token count parseable (M5)", () => {
  test("the OpenAI-style overflow message survives friendlyError so the heal can size it", () => {
    const raw = new Error("This model's maximum context length is 8192 tokens, however you requested 9000");
    const friendly = friendlyError(raw, "openai");
    expect(friendly.message).toMatch(/auto-compacting/i); // still the friendly framing
    expect(parseContextLimit(friendly)).toBe(8192);        // …but the number is no longer stripped
  });
});

describe("parseContextLimit", () => {
  test("llama.cpp: 'exceeds the available context size (64000 tokens)'", () => {
    const msg = '400 {"error":{"message":"request (68645 tokens) exceeds the available context size (64000 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":68645,"n_ctx":64000}}';
    expect(parseContextLimit(new Error(msg))).toBe(64000);
  });
  test("falls back to the n_ctx field in the JSON body", () => {
    expect(parseContextLimit('{"type":"exceed_context_size_error","n_ctx":32768}')).toBe(32768);
  });
  test("OpenAI phrasing: 'maximum context length is N tokens'", () => {
    expect(parseContextLimit(new Error("This model's maximum context length is 128000 tokens, however you requested ..."))).toBe(128000);
  });
  test("non-context errors return null", () => {
    expect(parseContextLimit(new Error("429 rate limit"))).toBeNull();
    expect(parseContextLimit(new Error("connection refused"))).toBeNull();
  });
  test("isContextOverflow recognises the phrasing", () => {
    expect(isContextOverflow(new Error("exceed_context_size_error"))).toBe(true);
    expect(isContextOverflow(new Error("exceeds the available context size (64000 tokens)"))).toBe(true);
    expect(isContextOverflow(new Error("500 internal error"))).toBe(false);
  });
});

// First stream attempt rejects with a llama.cpp context-overflow 400; later
// attempts succeed. The loop must learn the limit, shrink, and retry.
class OverflowThenOk implements Provider {
  id = "mock";
  name = "ovf";
  calls = 0;
  models() { return ["mock-1"]; }
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new Error('400 {"error":{"message":"request (68645 tokens) exceeds the available context size (64000 tokens)","type":"exceed_context_size_error","n_prompt_tokens":68645,"n_ctx":64000}}');
    }
    yield { type: "text_delta", delta: "recovered after compacting" };
    yield { type: "usage", usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 } };
    yield { type: "end", reason: "end_turn" };
  }
}

describe("agent loop self-heals a context overflow", () => {
  test("learns the real window, compacts, and retries instead of failing the turn", async () => {
    const provider = new OverflowThenOk();
    const events: AgentEvent[] = [];
    let learned = 0;
    // Enough history that messages.length > 1 and there's something to compact.
    const history: ChatMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `earlier turn ${i} ` + "detail ".repeat(50),
    }));
    const result = await runAgentLoop({
      tools: [],
      model: "mock-1",
      maxTurns: 3,
      permission: createPermissionEngine("bypass"),
      promptUser: (async () => "allow") as ApprovalCallback,
      provider,
      prompt: "continue the port",
      history,
      contextWindow: 82176, // what /props over-reported
      contextThreshold: 0.8,
      onContextLimit: (n) => { learned = n; },
      onEvent: (e) => events.push(e),
    });
    expect(learned).toBe(64000);                 // learned the server's real limit
    expect(provider.calls).toBeGreaterThanOrEqual(2); // retried after shrinking
    expect(result.aborted).toBe(false);          // recovered, didn't dead-end
    expect(result.messages.some((m) => m.role === "assistant" && m.content.includes("recovered"))).toBe(true);
    expect(events.some((e) => e.type === "compacted" && /context limit/i.test(e.text ?? ""))).toBe(true);
  });
});
