// Context-fill gauge. The bar math, tone thresholds, and the tracker's
// "how full is the window now" calculation are pure, so they're pinned here.
import { test, expect, describe } from "bun:test";
import { contextBar, contextTone, formatTokens } from "../src/tui/context-bar";
import { ContextTracker } from "../src/agent/context";

describe("contextBar", () => {
  test("fills proportionally and clamps out-of-range input", () => {
    expect(contextBar(0, 10)).toBe("░░░░░░░░░░");
    expect(contextBar(1, 10)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect(contextBar(0.5, 10)).toBe("▓▓▓▓▓░░░░░");
    expect(contextBar(1.5, 10)).toBe("▓▓▓▓▓▓▓▓▓▓"); // clamp high
    expect(contextBar(-3, 10)).toBe("░░░░░░░░░░"); // clamp low
    expect(contextBar(NaN, 4)).toBe("░░░░"); // non-finite → empty
  });
});

describe("contextTone", () => {
  test("bands at 60% and 85%", () => {
    expect(contextTone(0.2)).toBe("ok");
    expect(contextTone(0.59)).toBe("ok");
    expect(contextTone(0.6)).toBe("warn");
    expect(contextTone(0.84)).toBe("warn");
    expect(contextTone(0.85)).toBe("crit");
    expect(contextTone(1)).toBe("crit");
  });
});

describe("formatTokens", () => {
  test("compacts to k / M", () => {
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(8_200)).toBe("8.2k");
    expect(formatTokens(96_000)).toBe("96k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("ContextTracker.contextFill", () => {
  test("reflects the LATEST turn's prompt+completion, not the session sum", () => {
    const t = new ContextTracker({ windowSize: 100_000 });
    expect(t.contextFill()).toBe(0); // nothing recorded yet
    t.record({ input: 20_000, output: 1_000, cacheRead: 0, cacheWrite: 0, thinking: 0 });
    expect(t.contextTokens()).toBe(21_000);
    expect(t.contextFill()).toBeCloseTo(0.21, 5);
    // A later, larger turn replaces the gauge (not summed with the first).
    t.record({ input: 50_000, output: 2_000, cacheRead: 0, cacheWrite: 0, thinking: 0 });
    expect(t.contextTokens()).toBe(52_000);
    expect(t.contextFill()).toBeCloseTo(0.52, 5);
    // ...even though cumulative cost-tracking kept summing.
    expect(t.totalUsed()).toBe(73_000);
  });

  test("clamps to 1 when a turn exceeds the window, and follows setWindow", () => {
    const t = new ContextTracker({ windowSize: 10_000 });
    t.record({ input: 12_000, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });
    expect(t.contextFill()).toBe(1);
    t.setWindow(200_000);
    expect(t.contextFill()).toBeCloseTo(0.06, 5);
    expect(t.window()).toBe(200_000);
  });
});
