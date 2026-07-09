import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ContextTracker } from "../src/agent/context";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";
import type { Tool } from "../src/tools/types";

describe("ContextTracker.compact (V14)", () => {
  it("summarizes the middle into a leading USER message + keeps the tail", async () => {
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
    // No leading system message in this history → summary leads, as a USER msg.
    expect(res.messages[0]?.role).toBe("user");
    expect(res.messages[0]?.content).toContain("SUMMARY");
  });

  it("NEVER places a system message after position 0 (strict templates reject it)", async () => {
    const tracker = new ContextTracker({ windowSize: 100, threshold: 0.5 });
    // History with a genuine leading system message, then the conversation.
    const messages = [
      { role: "system" as const, content: "SYS" },
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "u2" },
      { role: "assistant" as const, content: "a2" },
      { role: "user" as const, content: "u3" },
      { role: "assistant" as const, content: "a3" },
    ];
    const res = await tracker.compact(messages, async () => "SUMMARY");
    // Leading system message preserved at index 0…
    expect(res.messages[0]?.role).toBe("system");
    // …and the summary is a USER message, not a second/mid system message.
    expect(res.messages[1]?.role).toBe("user");
    expect(res.messages[1]?.content).toContain("SUMMARY");
    // The invariant: no system message anywhere past index 0.
    expect(res.messages.slice(1).some((m) => m.role === "system")).toBe(false);
  });

  it("reports the token reclaim (before/after) so it's visible, not silent", async () => {
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
    // The reclaim is reported as real numbers (a tiny history can even grow — the
    // summary wrapper outweighs the few tokens saved; the win shows on big inputs,
    // covered by the tool-output trim test below).
    expect(typeof res.beforeTokens).toBe("number");
    expect(res.beforeTokens).toBeGreaterThan(0);
    expect(typeof res.afterTokens).toBe("number");
    expect(res.afterTokens).toBeGreaterThan(0);
  });

  it("stubs oversized tool outputs in the OLDER tail but keeps the recent ones", async () => {
    // tool_result outputs dominate a coding session's tokens; summarizing the old
    // portion isn't enough if the kept tail still carries fat dumps. Verify the
    // older-tail big output is stubbed (pairing preserved) and the recent one isn't.
    const tracker = new ContextTracker({ windowSize: 100, threshold: 0.5 });
    const big = "X".repeat(8000); // > the 6000-char cap
    const msgs: import("../src/providers/types").ChatMessage[] = [];
    for (let i = 0; i < 26; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `lead${i}` });
    msgs.push({ role: "user", content: "tail-boundary" });                                          // 26 (non-tool boundary)
    msgs.push({ role: "assistant", content: "", toolCalls: [{ id: "old", name: "FileRead", arguments: {} }] }); // 27
    msgs.push({ role: "tool", toolCallId: "old", content: big });                                    // 28 OLD big output
    for (let i = 0; i < 3; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `mid${i}` }); // 29,30,31
    msgs.push({ role: "assistant", content: "", toolCalls: [{ id: "new", name: "FileRead", arguments: {} }] }); // 32
    msgs.push({ role: "tool", toolCallId: "new", content: big });                                    // 33 RECENT big output
    msgs.push({ role: "user", content: "latest" });                                                 // 34,35
    msgs.push({ role: "assistant", content: "done" });

    const res = await tracker.compact(msgs, async () => "S");
    const stubbed = res.messages.filter((m) => (m.content ?? "").includes("trimmed to save context"));
    expect(stubbed).toHaveLength(1); // exactly the OLD big output
    expect(res.messages.some((m) => m.role === "tool" && m.content === big)).toBe(true); // RECENT one intact
    expect(res.afterTokens).toBeLessThan(res.beforeTokens);
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
    const perm = createPermissionEngine("bypass");
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
