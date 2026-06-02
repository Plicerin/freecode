import { describe, it, expect } from "bun:test";
import { runAgentLoop } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent, ChatMessage } from "../src/providers/types";

class CapturingProvider implements Provider {
  id = "mock"; name = "cap";
  seen: ChatMessage[][] = [];
  models() { return ["m"]; }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(req.messages);
    yield { type: "text_delta", delta: "ok" };
    yield { type: "end", reason: "end_turn" };
  }
}

describe("multi-turn conversation memory", () => {
  it("threads prior turns into the next request", async () => {
    const perm = createPermissionEngine("bypass", (async () => "allow") as ApprovalCallback);
    const p = new CapturingProvider();
    const base = { provider: p, tools: [], model: "m", maxTurns: 2, permission: perm, promptUser: (async () => "allow") as ApprovalCallback, onEvent: () => {} };

    const r1 = await runAgentLoop({ ...base, prompt: "first" });
    const r2 = await runAgentLoop({ ...base, prompt: "second", history: r1.messages });

    const lastReq = p.seen[p.seen.length - 1]!;
    expect(lastReq.some((m) => m.role === "user" && m.content === "first")).toBe(true);
    expect(lastReq.some((m) => m.role === "user" && m.content === "second")).toBe(true);
    expect(r2.messages.length).toBeGreaterThan(r1.messages.length);
  });
});
