import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ContextTracker } from "../src/agent/context";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";
import type { Tool } from "../src/tools/types";

describe("ContextTracker.compact (V14)", () => {
  it("keeps head + tail, summarizes the middle", async () => {
    const tracker = new ContextTracker({ windowSize: 100, threshold: 0.5 });
    const messages = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "u2" },
      { role: "assistant" as const, content: "a2" },
      { role: "user" as const, content: "u3" },
      { role: "assistant" as const, content: "a3" },
    ];
    const res = await tracker.compact(messages, async () => "SUMMARY");
    expect(res.removedCount).toBeGreaterThan(0);
    expect(res.messages[0]).toEqual(messages[0]); // head preserved
    expect(res.messages[1]?.content).toContain("SUMMARY"); // summary stub inserted
  });

  it("never leaves an orphan tool message at the tail boundary", async () => {
    const tracker = new ContextTracker({ windowSize: 100, threshold: 0.5 });
    const messages = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "1", name: "X", arguments: {} }] },
      { role: "tool" as const, toolCallId: "1", content: "r1" },
      { role: "tool" as const, toolCallId: "2", content: "r2" },
      { role: "assistant" as const, content: "done" },
      { role: "user" as const, content: "next" },
    ];
    const res = await tracker.compact(messages, async () => "S");
    // The first kept message after head+summary must not be a dangling tool result.
    const firstKept = res.messages[2];
    expect(firstKept?.role).not.toBe("tool");
  });
});

// A provider that emits a tool call each turn (while tools are present) until a
// limit, then ends — and returns plain text for tool-less summary requests.
class ToolLoopProvider implements Provider {
  id = "mock";
  name = "ToolLoop";
  private calls = 0;
  models() { return ["mock-1"]; }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const hasTools = (req.tools?.length ?? 0) > 0;
    if (hasTools && this.calls < 4) {
      this.calls += 1;
      yield { type: "text_delta", delta: "working " };
      yield { type: "tool_call", call: { id: `c${this.calls}`, name: "Noop", arguments: {} } };
      yield { type: "usage", usage: { input: 5000, output: 50, cacheRead: 0, cacheWrite: 0, thinking: 0 } };
      yield { type: "end", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", delta: hasTools ? "all done" : "RECAP" };
    yield { type: "usage", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, thinking: 0 } };
    yield { type: "end", reason: "end_turn" };
  }
}

describe("Agent loop auto-compaction (V14)", () => {
  it("emits a compacted event when the window fills", async () => {
    const noop: Tool = {
      name: "Noop",
      description: "no-op",
      schema: z.object({}),
      permission: "safe",
      async run() { return { ok: true, output: "ok" }; },
    };
    const events: AgentEvent[] = [];
    const perm = createPermissionEngine("bypass", (async () => "allow") as ApprovalCallback);
    await runAgentLoop({
      provider: new ToolLoopProvider(),
      tools: [noop],
      model: "mock-1",
      maxTurns: 10,
      prompt: "go",
      permission: perm,
      promptUser: (async () => "allow") as ApprovalCallback,
      contextWindow: 5000,      // tiny window so 5000-token turns exceed 0.8*window
      contextThreshold: 0.8,
      onEvent: (e) => events.push(e),
    });
    const compacted = events.filter((e) => e.type === "compacted");
    expect(compacted.length).toBeGreaterThan(0);
  });
});
