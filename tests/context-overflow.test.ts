// The pre-send overflow guard: when the outgoing prompt won't fit the model's
// context window (even after compaction), the loop must stop with a clear error
// BEFORE calling the provider — not let the provider 400 on a negative max_tokens.
import { test, expect, describe } from "bun:test";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";

// Records whether it was ever asked to stream — the guard must fire first.
class SpyProvider implements Provider {
  id = "mock";
  name = "Spy";
  streamed = false;
  models() { return ["mock-1"]; }
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.streamed = true;
    yield { type: "text_delta", delta: "should not happen" };
    yield { type: "end", reason: "end_turn" };
  }
}

const perm = createPermissionEngine("bypass");
const base = {
  tools: [],
  model: "mock-1",
  maxTurns: 5,
  permission: perm,
  promptUser: (async () => "allow") as ApprovalCallback,
};

describe("context-overflow guard", () => {
  test("emits a clear error and never streams when the prompt overflows the window", async () => {
    const provider = new SpyProvider();
    const events: AgentEvent[] = [];
    await runAgentLoop({
      ...base,
      provider,
      prompt: "x".repeat(20_000), // ~5000 tokens, far over a 100-token window
      contextWindow: 100,
      contextThreshold: 0.8,
      onEvent: (e) => events.push(e),
    });
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err?.error).toMatch(/context window/i);
    expect(err?.error).toMatch(/\/new/);
    expect(provider.streamed).toBe(false); // stopped before the doomed request
  });

  test("a normal prompt under a real window proceeds (no false overflow)", async () => {
    const provider = new SpyProvider();
    const events: AgentEvent[] = [];
    await runAgentLoop({
      ...base,
      provider,
      prompt: "hello there",
      contextWindow: 200_000,
      contextThreshold: 0.8,
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(provider.streamed).toBe(true);
  });
});
