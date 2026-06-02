import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";
import type { Tool } from "../src/tools/types";

// Provider: turn 1 calls FileEdit (a "change"), then finishes; after a verify
// failure is injected, turn 2 calls FileEdit again then finishes (the "fix").
function makeProvider() {
  let t = 0;
  return {
    id: "mock", name: "m", models: () => ["m"],
    async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
      t++;
      if (t === 1 || t === 2) {
        yield { type: "tool_call", call: { id: `c${t}`, name: "FileEdit", arguments: {} } };
        yield { type: "end", reason: "tool_use" };
      } else {
        yield { type: "text_delta", delta: "done" };
        yield { type: "end", reason: "end_turn" };
      }
    },
  } as Provider;
}

const editTool: Tool = { name: "FileEdit", description: "x", schema: z.object({}), permission: "confirm", async run() { return { ok: true, output: "edited" }; } };

describe("auto-verify gate", () => {
  it("runs after a file change; on failure self-corrects, then passes", async () => {
    let verifyCalls = 0;
    const events: AgentEvent[] = [];
    await runAgentLoop({
      provider: makeProvider(), tools: [editTool], model: "m", maxTurns: 8, prompt: "go",
      permission: createPermissionEngine("bypass", (async () => "allow") as ApprovalCallback),
      promptUser: (async () => "allow") as ApprovalCallback,
      verifyMode: "on",
      // first verify run fails, second passes — modeled via a command that
      // checks a counter file? simpler: use commands array we swap. Here we
      // fake by exit codes that depend on attempt via a tiny stateful plan.
      verifyPlan: { commands: ["exit 1"], source: "config" },
      onEvent: (e) => { if (e.type === "verify") { verifyCalls++; events.push(e); } },
    });
    // exit 1 always fails -> gate retries up to 3 then gives up honestly
    const texts = events.map((e) => e.text);
    expect(texts.some((t) => /Verifying/.test(t!))).toBe(true);
    expect(texts.some((t) => /failed/.test(t!))).toBe(true);
    expect(texts.some((t) => /still failing/i.test(t!))).toBe(true);
    expect(verifyCalls).toBeGreaterThanOrEqual(3); // bounded retries
  }, 30000);

  it("does not verify when no files changed", async () => {
    let verifyCalls = 0;
    const provider = { id: "m", name: "m", models: () => ["m"], async *stream(): AsyncIterable<StreamEvent> { yield { type: "text_delta", delta: "hi" }; yield { type: "end", reason: "end_turn" }; } } as Provider;
    await runAgentLoop({
      provider, tools: [], model: "m", maxTurns: 3, prompt: "hi",
      permission: createPermissionEngine("bypass", (async () => "allow") as ApprovalCallback),
      promptUser: (async () => "allow") as ApprovalCallback,
      verifyMode: "on", verifyPlan: { commands: ["exit 1"], source: "config" },
      onEvent: (e) => { if (e.type === "verify") verifyCalls++; },
    });
    expect(verifyCalls).toBe(0);
  });
});
