// The <Static> scrollback must be APPEND-ONLY. Ink's <Static> writes only items
// past what it already emitted, so mutating a PREFIX makes it re-emit shifted
// items and repaint from the top. The bug: a startup message (memory/MCP status)
// settled into Static before the intro splash finished; when the intro then
// prepended, it shifted the message → the message DUPLICATED and the terminal
// jumped to the top. This pins the fix: Static is gated on introReady, so the
// intro is always index 0 from the first render and the array only grows.
import { test, expect, describe } from "bun:test";
import { buildStaticItems, clampToViewport, type UiMessage } from "../src/commands/repl";

const msg = (id: string, text = "x"): UiMessage => ({ id, role: "system", text });

describe("buildStaticItems (append-only Static invariant)", () => {
  test("empty until the intro splash settles", () => {
    expect(buildStaticItems(false, [msg("mem-1")], 1)).toEqual([]);
  });

  test("once ready, intro is index 0 and each message appears exactly once", () => {
    const items = buildStaticItems(true, [msg("mem-1"), msg("mcp-1")], 2);
    expect(items[0]!.kind).toBe("intro");
    const msgs = items.filter((i) => i.kind === "msg");
    expect(msgs.map((i) => i.key)).toEqual(["mem-1:0", "mcp-1:1"]); // no duplicate
  });

  test("the reported bug: a message settled during the splash is not duplicated when the intro appears", () => {
    const m = [msg("mem-1", "🧠 memory: recalled 2779 chars")];
    // during splash: hidden (not written to Static yet)
    expect(buildStaticItems(false, m, 1)).toEqual([]);
    // splash ends: intro first, the memory message exactly once — NOT twice
    const after = buildStaticItems(true, m, 1);
    expect(after[0]!.kind).toBe("intro");
    expect(after.filter((i) => i.kind === "msg")).toHaveLength(1);
  });

  test("the prefix never mutates: intro stays index 0 as messages accrue (append-only)", () => {
    const m = [msg("a"), msg("b"), msg("c")];
    const one = buildStaticItems(true, m, 1);
    const three = buildStaticItems(true, m, 3);
    expect(one[0]!.key).toBe("intro");
    expect(three[0]!.key).toBe("intro");
    // the items present in the smaller render keep identical keys in the larger
    // one (Ink can safely treat the tail as new; the prefix is untouched).
    expect(three.slice(0, one.length).map((i) => i.key)).toEqual(one.map((i) => i.key));
  });

  test("only settled messages are included (the in-flight tail stays in the dynamic region)", () => {
    const m = [msg("a"), msg("b"), msg("c")];
    const items = buildStaticItems(true, m, 2); // settled=2 → a,b in Static; c is dynamic
    expect(items.filter((i) => i.kind === "msg").map((i) => i.key)).toEqual(["a:0", "b:1"]);
  });

  // After a marathon-session reset, the <Static> mount is remounted with base>0:
  // it renders ONLY the window [base, settled) and drops the intro (already in
  // scrollback). Earlier messages are the previous mount's / terminal's problem.
  test("with a base offset, the intro is gone and only the window [base, settled) renders", () => {
    const m = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];
    const items = buildStaticItems(true, m, 5, 3); // base=3 → only d,e; no intro
    expect(items.some((i) => i.kind === "intro")).toBe(false);
    expect(items.map((i) => i.key)).toEqual(["d:3", "e:4"]); // keys stay globally unique
  });

  test("base defaults to 0 (unchanged behavior) — intro present, full settled range", () => {
    const m = [msg("a"), msg("b")];
    expect(buildStaticItems(true, m, 2)).toEqual(buildStaticItems(true, m, 2, 0));
    expect(buildStaticItems(true, m, 2)[0]!.kind).toBe("intro");
  });
});

// The in-flight assistant bubble lives in Ink's DYNAMIC (repainted) region. Ink
// erases that region by moving up `lastOutputHeight` rows — once it's taller than
// the terminal, the scrolled-off lines can't be erased and the repaint corrupts, so
// a long streamed reply garbles or VANISHES mid-stream (worst with verbose local
// models like a 1-bit quant listing its capabilities). clampToViewport bounds the
// live region to the TAIL that fits; the full text still lands in <Static> on settle.
describe("clampToViewport (bounds the streamed live region to the viewport)", () => {
  test("short text under the budget is returned whole, unclipped", () => {
    const r = clampToViewport("line1\nline2\nline3", 10, 80);
    expect(r.clipped).toBe(false);
    expect(r.text).toBe("line1\nline2\nline3");
    expect(r.rows).toBe(3);
  });

  test("text taller than the budget keeps the TAIL (the newest lines) and marks clipped", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const r = clampToViewport(text, 5, 80);
    expect(r.clipped).toBe(true);
    const kept = r.text.split("\n");
    expect(kept.length).toBeLessThanOrEqual(5);
    expect(kept.at(-1)).toBe("line19");          // newest line is always kept
    expect(r.text).not.toMatch(/line0\b/);        // oldest lines dropped
  });

  test("wrapped long lines count for their full wrapped height", () => {
    // one 200-char line at 50 cols wraps to 4 rows.
    const r = clampToViewport("x".repeat(200), 10, 50);
    expect(r.rows).toBe(4);
    expect(r.clipped).toBe(false);
  });

  test("always keeps at least one (tail) line even when it alone exceeds the budget", () => {
    // a single line that wraps to 8 rows, budget only 3 — can't drop everything.
    const r = clampToViewport("y".repeat(400), 3, 50);
    expect(r.text).toBe("y".repeat(400));         // the one line survives
    expect(r.clipped).toBe(false);                // nothing left to drop → not marked clipped
  });

  test("a zero/undefined width falls back to a sane column count (no divide-by-zero)", () => {
    const r = clampToViewport("hello", 10, 0);
    expect(r.rows).toBe(1);
    expect(r.clipped).toBe(false);
  });
});
