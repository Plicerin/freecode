// The <Static> scrollback must be APPEND-ONLY. Ink's <Static> writes only items
// past what it already emitted, so mutating a PREFIX makes it re-emit shifted
// items and repaint from the top. The bug: a startup message (memory/MCP status)
// settled into Static before the intro splash finished; when the intro then
// prepended, it shifted the message → the message DUPLICATED and the terminal
// jumped to the top. This pins the fix: Static is gated on introReady, so the
// intro is always index 0 from the first render and the array only grows.
import { test, expect, describe } from "bun:test";
import { buildStaticItems, type UiMessage } from "../src/commands/repl";

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
});
