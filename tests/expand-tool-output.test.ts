// /expand must read tool output from the DURABLE session log, not the live model
// context — auto-compaction/trimming evicts tool results from context, which made
// /expand say "nothing to expand" right when the preview still dangled
// "(/expand to view)". toolOutputs() is the source it now reads.
import { test, expect, describe } from "bun:test";
import { toolOutputs, type SessionEvent } from "../src/session/manager";

const ev = {
  user: (text: string): SessionEvent => ({ kind: "user", text, ts: "t" }),
  toolResult: (output: string, ok = true): SessionEvent => ({ kind: "tool_result", id: "x", output, ok, ts: "t", durationMs: 1 }),
  toolCall: (): SessionEvent => ({ kind: "tool_call", id: "x", name: "Glob", args: {}, ts: "t" }),
};

describe("toolOutputs (the /expand source)", () => {
  test("returns every tool_result's full output, oldest→newest", () => {
    const events = [ev.user("hi"), ev.toolCall(), ev.toolResult("FIRST"), ev.user("more"), ev.toolResult("SECOND")];
    expect(toolOutputs(events)).toEqual(["FIRST", "SECOND"]);
  });

  test("skips non-tool_result events and empty outputs", () => {
    expect(toolOutputs([ev.user("x"), ev.toolCall(), ev.toolResult("")])).toEqual([]);
  });

  test("nth-most-recent indexing works (what /expand does)", () => {
    const outs = toolOutputs([ev.toolResult("A"), ev.toolResult("B"), ev.toolResult("C")]);
    expect(outs[outs.length - 1]).toBe("C"); // /expand 1 = most recent
    expect(outs[outs.length - 2]).toBe("B"); // /expand 2
    expect(outs[outs.length - 5]).toBeUndefined(); // out of range → "only N results"
  });

  test("survives a log where context would have been compacted away", () => {
    // The session log keeps the big Glob result even after the model context was
    // trimmed — so /expand still finds it.
    const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const events = [ev.toolResult(big), ev.user("…"), ev.user("(later, after compaction)")];
    expect(toolOutputs(events)).toHaveLength(1);
    expect(toolOutputs(events)[0]!.split("\n")).toHaveLength(300);
  });
});
