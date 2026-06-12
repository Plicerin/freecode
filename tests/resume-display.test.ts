// /resume must reconstruct the VISIBLE transcript from stored events — including
// tool calls and their results. The old restore read `e.text` (tool_result stores
// `output`) and dropped tool_call events entirely, so a resumed session rendered
// rows of bare ⚙ gears. This guards the corrected mapper.
import { test, expect, describe } from "bun:test";
import { restoredMessagesFromEvents } from "../src/commands/repl";
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

  test("user/assistant text restored; an empty (tool-only) assistant turn is skipped", () => {
    expect(msgs.find((m) => m.role === "user")!.text).toBe("find the planet code");
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1); // the empty one is dropped
    expect(assistants[0]!.text).toBe("The planet draws shape 5.");
  });
});
