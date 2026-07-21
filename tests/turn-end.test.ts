// "Activity just ends" should never be silent. The loop must surface WHY a turn
// stopped: a reply truncated at the token cap, an empty reply, or the max-turns
// cap — so it's clear whether it was the model or freecode.
import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent } from "../src/providers/types";
import type { Tool } from "../src/tools/types";

const perm = createPermissionEngine("bypass");
const base = {
  model: "mock-1",
  permission: perm,
  promptUser: (async () => "allow") as ApprovalCallback,
};
const errors = (events: AgentEvent[]) => events.filter((e) => e.type === "error").map((e) => e.error ?? "");
const notes = (events: AgentEvent[]) => events.filter((e) => e.type === "compacted").map((e) => e.text ?? "");

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
  test("a reply truncated at the token cap surfaces a note and does NOT auto-continue (no nudge)", async () => {
    // finish_reason=length is a REAL truncation, but freecode must not inject a
    // "continue" on the model's behalf (that nudge was removed). It states the fact
    // once, keeps the partial reply, and ends the turn — the user decides.
    let calls = 0;
    const p = new ScriptedProvider(() => { calls++; return [
      { type: "text_delta", delta: "let me start by editing" },
      { type: "end", reason: "max_tokens" },
    ]; });
    const ev = await run(p, [], 8);
    expect(errors(ev).some((m) => /truncated|token limit/i.test(m))).toBe(true); // the cutoff is surfaced
    expect(notes(ev).some((m) => /auto-continu/i.test(m))).toBe(false);          // NO nudge / re-prompt
    expect(calls).toBe(1); // ended the turn — did not loop back to puppeteer the model
    expect(ev.some((e) => e.type === "done")).toBe(true);
  });

  test("an empty reply (no text, no tool call) is flagged as model-side", async () => {
    const p = new ScriptedProvider(() => [{ type: "end", reason: "end_turn" }]);
    const e = errors(await run(p));
    expect(e.some((m) => /empty response/i.test(m))).toBe(true);
  });

  test("an empty turn AFTER a real answer is NOT flagged (benign trailing turn)", async () => {
    // Turn 1: answer + a tool call (so the loop continues). Turn 2: empty.
    let n = 0;
    const noop: Tool = { name: "Noop", description: "no-op", schema: z.object({}), permission: "safe", async run() { return { ok: true, output: "ok" }; } };
    const p = new ScriptedProvider(() => (n++ === 0
      ? [{ type: "text_delta", delta: "Done — cleaned up the stale manifests." }, { type: "tool_call", call: { id: "c1", name: "Noop", arguments: {} } }, { type: "end", reason: "tool_use" }]
      : [{ type: "end", reason: "end_turn" }]));
    expect(errors(await run(p, [noop]))).toEqual([]); // no empty-response warning
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

  test("maxTurns 0 = uncapped: runs well past a small budget, then finishes with NO cap warning", async () => {
    // 12 tool-call turns (far more than a cap of 3 would allow) then a clean finish.
    // With maxTurns 0 the loop must keep going and stop only on the model's own
    // no-tool-calls 'done' — never the cap.
    const noop: Tool = { name: "Noop", description: "no-op", schema: z.object({ i: z.number().optional() }), permission: "safe", async run() { return { ok: true, output: "ok" }; } };
    let n = 0;
    // DISTINCT args each turn — real productive work varies its calls; only the
    // stuck-loop guard cares about identical repeats (tested separately below).
    const p = new ScriptedProvider(() => (n++ < 12
      ? [{ type: "tool_call", call: { id: `c${n}`, name: "Noop", arguments: { i: n } } }, { type: "end", reason: "tool_use" }]
      : [{ type: "text_delta", delta: "done." }, { type: "end", reason: "end_turn" }]));
    const ev = await run(p, [noop], 0); // 0 = uncapped
    expect(errors(ev).some((m) => /max-turns cap/i.test(m))).toBe(false);          // never warns
    expect(ev.some((e) => e.type === "done" && (e as { reason?: string }).reason === "end_turn")).toBe(true); // finished cleanly
  });

  test("loop guard: the identical tool call repeated forever is stopped (uncapped ≠ infinite)", async () => {
    const noop: Tool = { name: "Noop", description: "no-op", schema: z.object({}), permission: "safe", async run() { return { ok: true, output: "ok" }; } };
    // A model wedged on a SUCCEEDING tool — same call, same args, forever. Without a
    // guard, maxTurns=0 would run it unbounded; the guard must stop it.
    const p = new ScriptedProvider(() => [{ type: "tool_call", call: { id: "c", name: "Noop", arguments: {} } }, { type: "end", reason: "tool_use" }]);
    const ev = await run(p, [noop], 0); // uncapped
    expect(errors(ev).some((m) => /looping|repeated/i.test(m))).toBe(true); // guard tripped
    expect(ev.some((e) => e.type === "done")).toBe(true);                   // and it terminated
  });
});
