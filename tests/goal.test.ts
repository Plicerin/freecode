// /goal — the autonomous loop's pure pieces: reading the model's self-reported
// status, framing each cycle's prompt, and deciding whether to iterate again.
// (The REPL loop wiring + esc-abort is verified live; the harness can't drive keys.)
import { test, expect, describe } from "bun:test";
import { goalStatus, goalPrompt, goalDecision, GOAL_MAX_DEFAULT } from "../src/agent/goal";

describe("goalStatus", () => {
  test("reads DONE / CONTINUE from the last line, case-insensitive", () => {
    expect(goalStatus("did the thing\nGOAL: DONE")).toBe("done");
    expect(goalStatus("more to do\ngoal: continue")).toBe("continue");
    expect(goalStatus("work\n\nGOAL:   DONE  ")).toBe("done");
  });

  test("prefers the tail when both appear (early plan vs final verdict)", () => {
    const text = "Plan: I'll keep going (GOAL: CONTINUE was my earlier note)\n...\nGOAL: DONE";
    expect(goalStatus(text)).toBe("done");
  });

  test("finds a marker even if not on the very last line", () => {
    expect(goalStatus("GOAL: CONTINUE\nsome trailing prose\nmore prose")).toBe("continue");
  });

  test("no marker → unknown", () => {
    expect(goalStatus("I finished everything, looks great!")).toBe("unknown");
    expect(goalStatus("")).toBe("unknown");
  });

  test("doesn't match the word inside another token", () => {
    expect(goalStatus("the GOAL: DONENESS is unclear")).toBe("unknown");
  });
});

describe("goalPrompt", () => {
  test("cycle 0 states the goal; later cycles continue it; both demand the marker", () => {
    const first = goalPrompt("ship the parser", 0);
    expect(first).toContain("GOAL: ship the parser");
    expect(first).toContain("GOAL: DONE");
    expect(first).toContain("GOAL: CONTINUE");

    const next = goalPrompt("ship the parser", 3);
    expect(next).toContain("Continue toward the GOAL: ship the parser");
    expect(next).toContain("GOAL: DONE");
  });
});

describe("goalDecision", () => {
  const base = { status: "continue" as const, aborted: false, completed: 1, max: GOAL_MAX_DEFAULT };

  test("abort wins over everything", () => {
    expect(goalDecision({ ...base, aborted: true, status: "done" })).toBe("stop-aborted");
  });
  test("DONE finishes", () => {
    expect(goalDecision({ ...base, status: "done" })).toBe("done");
  });
  test("continues while under the cap", () => {
    expect(goalDecision({ ...base, status: "continue", completed: 5, max: 12 })).toBe("continue");
    expect(goalDecision({ ...base, status: "unknown", completed: 5, max: 12 })).toBe("continue"); // unknown keeps going
  });
  test("stops at the cap without a DONE", () => {
    expect(goalDecision({ ...base, status: "continue", completed: 12, max: 12 })).toBe("stop-max");
    expect(goalDecision({ ...base, status: "unknown", completed: 13, max: 12 })).toBe("stop-max");
  });
});
