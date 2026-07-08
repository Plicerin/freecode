// /resume must reconstruct the VISIBLE transcript from stored events — including
// tool calls and their results. The old restore read `e.text` (tool_result stores
// `output`) and dropped tool_call events entirely, so a resumed session rendered
// rows of bare ⚙ gears. This guards the corrected mapper.
import { test, expect, describe } from "bun:test";
import { restoredMessagesFromEvents, inputHistoryFromEvents } from "../src/commands/repl";
import type { SessionEvent } from "../src/session/manager";

const events: SessionEvent[] = [
  { kind: "user", text: "find the planet code", ts: "t" },
  { kind: "tool_call", id: "1", name: "Grep", args: { pattern: "DRAW" }, ts: "t" },
  { kind: "tool_result", id: "1", output: "src/planet.ts:12: DRAW shape 5\nsrc/planet.ts:14: HCOLOR 3", ok: true, ts: "t", durationMs: 7 },
  { kind: "assistant", text: "", ts: "t" },            // tool-only turn — no visible text
  { kind: "tool_call", id: "2", name: "FileRead", args: { path: "src/planet.ts" }, ts: "t" },
  { kind: "tool_result", id: "2", output: "(file contents…)", ok: true, ts: "t", durationMs: 3 },
  { kind: "assistant", text: "The planet draws shape 5.", ts: "t" },
];

describe("restoredMessagesFromEvents (/resume transcript)", () => {
  const msgs = restoredMessagesFromEvents(events, "sess");

  test("tool calls reappear as '→ name(args)', not bare gears", () => {
    const calls = msgs.filter((m) => m.role === "tool" && m.text.startsWith("→"));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain("→ Grep(");
    expect(calls[0]!.text).toContain("DRAW");
    expect(calls[0]!.toolName).toBe("Grep");
    expect(calls[1]!.text).toContain("→ FileRead(");
  });

  test("tool results show their output preview, never empty", () => {
    const results = msgs.filter((m) => m.role === "tool" && m.toolName === "result");
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.text.length).toBeGreaterThan(0);
    expect(results[0]!.text).toContain("DRAW shape 5");
    expect(results[0]!.ok).toBe(true);
  });

  test("NO tool message is left textless (the bare-gear bug)", () => {
    const blank = msgs.filter((m) => m.role === "tool" && !m.text.trim());
    expect(blank).toHaveLength(0);
  });

  test("a tool that returned NOTHING still shows a labelled row, not a bare gear", () => {
    const evs: SessionEvent[] = [
      { kind: "tool_call", id: "9", name: "FileWrite", args: { path: "x.ts" }, ts: "t" },
      { kind: "tool_result", id: "9", output: "", ok: true, ts: "t", durationMs: 1 }, // no stdout
    ];
    const out = restoredMessagesFromEvents(evs, "s");
    const result = out.find((m) => m.toolName === "result")!;
    expect(result.text.trim()).toBe("(no output)");
  });

  test("user/assistant text restored; an empty (tool-only) assistant turn is skipped", () => {
    expect(msgs.find((m) => m.role === "user")!.text).toBe("find the planet code");
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1); // the empty one is dropped
    expect(assistants[0]!.text).toBe("The planet draws shape 5.");
  });
});

describe("inputHistoryFromEvents (/resume restores up/down recall)", () => {
  const ev: SessionEvent[] = [
    { kind: "user", text: "list the files", ts: "t" },
    { kind: "assistant", text: "ok", ts: "t" },                          // not user → skipped
    { kind: "user", text: "/scan", ts: "t" },
    { kind: "user", text: "/scan", ts: "t" },                            // consecutive dup → collapsed
    { kind: "user", text: "Continue toward the GOAL: ship it\n\nYou are working AUTONOMOUSLY toward a goal — no one will reply.\nGOAL: DONE or GOAL: CONTINUE", ts: "t" }, // /goal FRAME → filtered
    { kind: "user", text: "! git status", ts: "t" },
    { kind: "user", text: 'Use the Agent tool with subagent_type "explore" to: find planet code', ts: "t" }, // /explore framing → filtered
    { kind: "tool_call", id: "1", name: "Grep", args: {}, ts: "t" },     // not user → skipped
  ];

  test("keeps typed prompts/commands, drops agentic auto-prompts, collapses consecutive dupes", () => {
    expect(inputHistoryFromEvents(ev)).toEqual(["list the files", "/scan", "! git status"]);
  });
  test("empty session → empty history", () => {
    expect(inputHistoryFromEvents([])).toEqual([]);
  });
});
