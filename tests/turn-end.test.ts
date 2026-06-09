// "Activity just ends" should never be silent. The loop must surface WHY a turn
// stopped: a reply truncated at the token cap, an empty reply, or the max-turns
// cap — so it's clear whether it was the model or freecode.
import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";
import type { Tool } from "../src/tools/types";

const perm = createPermissionEngine("bypass", (async () => "allow") as ApprovalCallback);
const base = {
  model: "mock-1",
  permission: perm,
  promptUser: (async () => "allow") as ApprovalCallback,
};
const errors = (events: AgentEvent[]) => events.filter((e) => e.type === "error").map((e) => e.error ?? "");

class ScriptedProvider implements Provider {
  id = "mock"; name = "Scripted";
  constructor(private readonly script: (req: ChatRequest) => StreamEvent[]) {}
  models() { return ["mock-1"]; }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> { for (const e of this.script(req)) yield e; }
}

async function run(provider: Provider, tools: Tool[] = [], maxTurns = 5): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await runAgentLoop({ ...base, provider, tools, maxTurns, prompt: "go", onEvent: (e) => events.push(e) });
  return events;
}

describe("turn-end surfacing", () => {
  test("a reply truncated at the token cap (max_tokens) is flagged", async () => {
    const p = new ScriptedProvider(() => [
      { type: "text_delta", delta: "let me start by editing" },
      { type: "end", reason: "max_tokens" },
    ]);
    const e = errors(await run(p));
    expect(e.some((m) => /token limit|cut off|finish_reason=length/i.test(m))).toBe(true);
  });

  test("an empty reply (no text, no tool call) is flagged as model-side", async () => {
    const p = new ScriptedProvider(() => [{ type: "end", reason: "end_turn" }]);
    const e = errors(await run(p));
    expect(e.some((m) => /empty response/i.test(m))).toBe(true);
  });

  test("a normal text reply does NOT trip either warning", async () => {
    const p = new ScriptedProvider(() => [
      { type: "text_delta", delta: "All set — here's the summary." },
      { type: "end", reason: "end_turn" },
    ]);
    expect(errors(await run(p))).toEqual([]);
  });

  test("hitting the max-turns cap is surfaced", async () => {
    // Always returns a tool call → never reaches the no-tool-calls 'done', so the
    // loop exhausts its turn budget.
    const noop: Tool = { name: "Noop", description: "no-op", schema: z.object({}), permission: "safe", async run() { return { ok: true, output: "ok" }; } };
    const p = new ScriptedProvider(() => [
      { type: "tool_call", call: { id: `c${Math.random()}`, name: "Noop", arguments: {} } },
      { type: "end", reason: "tool_use" },
    ]);
    const e = errors(await run(p, [noop], 3));
    expect(e.some((m) => /max-turns cap/i.test(m))).toBe(true);
  });
});
