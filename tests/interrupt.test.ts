import { describe, it, expect } from "bun:test";
import { runAgentLoop } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";

class SlowProvider implements Provider {
  id = "mock"; name = "Slow";
  models() { return ["m"]; }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    for (let i = 0; i < 200; i++) {
      if (req.signal?.aborted) throw new Error("aborted");
      yield { type: "text_delta", delta: "tick " };
      await new Promise((r) => setTimeout(r, 15));
    }
    yield { type: "end", reason: "end_turn" };
  }
}

describe("agent loop interrupt", () => {
  it("aborts a running turn when the signal fires", async () => {
    const controller = new AbortController();
    const perm = createPermissionEngine("bypass");
    setTimeout(() => controller.abort(), 60);
    const run = runAgentLoop({
      provider: new SlowProvider(), tools: [], model: "m", maxTurns: 3,
      prompt: "go", permission: perm, promptUser: (async () => "allow") as ApprovalCallback,
      signal: controller.signal, onEvent: () => {},
    });
    await expect(run).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });
});
