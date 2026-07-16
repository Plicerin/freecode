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
  test("a reply truncated at the token cap auto-continues, then finishes (no warning)", async () => {
    // Turn 1 is cut off mid-thought (max_tokens); turn 2 completes normally.
    let n = 0;
    const p = new ScriptedProvider(() => (n++ === 0
      ? [{ type: "text_delta", delta: "let me start by editing" }, { type: "end", reason: "max_tokens" }]
      : [{ type: "text_delta", delta: " — done." }, { type: "end", reason: "end_turn" }]));
    const ev = await run(p);
    expect(notes(ev).some((m) => /auto-continuing/i.test(m))).toBe(true); // it resumed on its own
    expect(errors(ev).some((m) => /token limit|cut off|finish_reason/i.test(m))).toBe(false); // no warning
  });

  test("a reply that KEEPS truncating warns once the auto-continue budget is spent", async () => {
    const p = new ScriptedProvider(() => [
      { type: "text_delta", delta: "still thinking" },
      { type: "end", reason: "max_tokens" },
    ]);
    const e = errors(await run(p, [], 8)); // enough turns to exhaust the 3 auto-continues
    expect(e.some((m) => /keeps hitting the output token limit/i.test(m))).toBe(true);
  });

  test("FREECODE_MAX_AUTO_CONTINUE=0 disables auto-continue (warns immediately)", async () => {
    const prev = process.env.FREECODE_MAX_AUTO_CONTINUE;
    process.env.FREECODE_MAX_AUTO_CONTINUE = "0";
    try {
      const p = new ScriptedProvider(() => [
        { type: "text_delta", delta: "cut off" },
        { type: "end", reason: "max_tokens" },
      ]);
      const ev = await run(p);
      expect(errors(ev).some((m) => /token limit|finish_reason=length/i.test(m))).toBe(true);
      expect(notes(ev).some((m) => /auto-continuing/i.test(m))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.FREECODE_MAX_AUTO_CONTINUE; else process.env.FREECODE_MAX_AUTO_CONTINUE = prev;
    }
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
