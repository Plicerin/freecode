// Sub-agents (ROADMAP Tier A). Verifies the three properties that matter:
// (1) a sub-agent returns its FINAL message (not its intermediate reasoning),
// (2) the Agent tool dispatches a sub-agent and surfaces that report, and
// (3) recursion is impossible — a dispatched sub-agent never receives an Agent
//     tool, even if the host context mistakenly includes one.
import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { runSubAgent } from "../src/agent/subagent";
import { createAgentTool } from "../src/tools/agent";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Tool } from "../src/tools/types";

const allow = (async () => "allow") as ApprovalCallback;
const perm = () => createPermissionEngine("bypass", allow);

// A provider scripted to emit a fixed sequence of events per turn.
function scripted(turns: Array<Array<Record<string, unknown>>>): unknown {
  let i = 0;
  return { name: "s", id: "s", models: () => ["x"], async *stream() { for (const e of turns[i++] ?? []) yield e; } };
}
const text = (delta: string) => ({ type: "text_delta", delta });
const call = (name: string, args: Record<string, unknown>) => ({ type: "tool_call", call: { id: `${name}-1`, name, arguments: args } });

// A stub tool that records whether it ran.
function probe(name: string): Tool & { ran: boolean } {
  const t = {
    name, description: "stub", permission: "safe" as const, ran: false,
    schema: z.object({}).passthrough(),
    async run() { t.ran = true; return { ok: true, output: `${name} ok` }; },
  };
  return t;
}

describe("runSubAgent", () => {
  test("returns the sub-agent's FINAL message, not its intermediate reasoning", async () => {
    const fileRead = probe("FileRead");
    const r = await runSubAgent({
      provider: scripted([
        [text("Let me look into this…"), call("FileRead", { path: "x" })],
        [text("FINAL REPORT: the answer is 42.")],
      ]) as never,
      model: "x", tools: [fileRead], permission: perm(), promptUser: allow,
      description: "investigate", prompt: "investigate x",
    });
    expect(fileRead.ran).toBe(true); // it actually used its tools
    expect(r.ok).toBe(true);
    expect(r.output).toBe("FINAL REPORT: the answer is 42.");
    expect(r.output).not.toContain("Let me look into this"); // not the intermediate text
  });
});

describe("Agent tool", () => {
  test("dispatches a sub-agent and returns its report", async () => {
    const tool = createAgentTool(() => ({
      provider: scripted([[text("done: found 3 matches.")]]) as never,
      model: "x", tools: [probe("Grep")], permission: perm(), promptUser: allow,
    }));
    const res = await tool.run(
      { description: "search", prompt: "find the matches" } as never,
      { cwd: process.cwd(), signal: undefined as unknown as AbortSignal },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("done: found 3 matches.");
  });

  test("recursion guard: the sub-agent never receives an Agent tool", async () => {
    // The host context wrongly includes a sentinel Agent; the sub-agent tries to
    // call it. If the guard works it's filtered out → never runs → no recursion.
    const sentinel = probe("Agent");
    const tool = createAgentTool(() => ({
      provider: scripted([
        [call("Agent", { description: "nested", prompt: "spawn another" })], // attempt to recurse
        [text("done without recursing")],
      ]) as never,
      model: "x", tools: [probe("Bash"), sentinel], permission: perm(), promptUser: allow,
    }));
    const res = await tool.run(
      { description: "task", prompt: "do it" } as never,
      { cwd: process.cwd(), signal: undefined as unknown as AbortSignal },
    );
    expect(sentinel.ran).toBe(false); // the Agent tool was stripped — no nesting
    expect(res.ok).toBe(true);
    expect(res.output).toBe("done without recursing");
  });
});
