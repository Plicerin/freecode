// /goal — the autonomous loop's pure pieces: reading the model's self-reported
// status, framing each cycle's prompt, and deciding whether to iterate again.
// (The REPL loop wiring + esc-abort is verified live; the harness can't drive keys.)
import { test, expect, describe, afterEach } from "bun:test";
import { goalStatus, goalPrompt, goalDecision, goalVerifyFailedPrompt, goalMax, GOAL_MAX_DEFAULT } from "../src/agent/goal";

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
  test("stops at the cap without a DONE (when a positive cap is set)", () => {
    expect(goalDecision({ ...base, status: "continue", completed: 12, max: 12 })).toBe("stop-max");
    expect(goalDecision({ ...base, status: "unknown", completed: 13, max: 12 })).toBe("stop-max");
  });
  test("max <= 0 is UNCAPPED — never stops on cycle count (the default)", () => {
    expect(GOAL_MAX_DEFAULT).toBe(0);
    expect(goalDecision({ ...base, status: "continue", completed: 999, max: 0 })).toBe("continue");
    expect(goalDecision({ ...base, status: "unknown", completed: 500, max: 0 })).toBe("continue");
  });
});

describe("goalMax (FREECODE_GOAL_MAX override)", () => {
  const saved = process.env.FREECODE_GOAL_MAX;
  afterEach(() => { if (saved === undefined) delete process.env.FREECODE_GOAL_MAX; else process.env.FREECODE_GOAL_MAX = saved; });
  test("defaults to 0 (uncapped)", () => {
    delete process.env.FREECODE_GOAL_MAX;
    expect(goalMax()).toBe(0);
  });
  test("a positive value re-imposes a cap", () => {
    process.env.FREECODE_GOAL_MAX = "25";
    expect(goalMax()).toBe(25);
  });
  test("a non-positive or junk value stays uncapped", () => {
    process.env.FREECODE_GOAL_MAX = "0"; expect(goalMax()).toBe(0);
    process.env.FREECODE_GOAL_MAX = "-4"; expect(goalMax()).toBe(0);
    process.env.FREECODE_GOAL_MAX = "abc"; expect(goalMax()).toBe(0);
  });
});

describe("goalVerifyFailedPrompt (the real DONE gate)", () => {
  test("frames the failing command as the next task and keeps the goal + marker contract", () => {
    const p = goalVerifyFailedPrompt("ship the parser", "npm test", "FAIL src/parse.test.ts\n  expected 3, got 2");
    expect(p).toContain("NOT done");           // rejects the model's premature DONE
    expect(p).toContain("$ npm test");          // names the failing command
    expect(p).toContain("expected 3, got 2");   // includes the real failure output
    expect(p).toContain("GOAL: ship the parser"); // re-anchors the objective
    expect(p).toContain("GOAL: DONE");          // keeps the status-marker contract
    expect(p).toMatch(/never weaken or skip the check/i); // don't game the gate
  });

  test("tolerates empty output", () => {
    expect(goalVerifyFailedPrompt("x", "tsc --noEmit", "")).toContain("(no output)");
  });
});
