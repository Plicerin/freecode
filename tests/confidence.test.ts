// Tests for attachWarning (the sidecar-onto-LAST-assistant helper). Drops the
// previous placeWarning sibling-line tests since placeWarning was removed from
// src/tui/confidence.ts as dead code (no caller after the ledger handler
// migrated to attachWarning).
import { test, expect, describe } from "bun:test";
import { attachWarning } from "../src/tui/confidence";

// Minimal message shape — UiMessage has many more fields; attachWarning only
// inspects `role` and writes `warning`, so a small interface is enough.
interface M { role: string; text: string; id: string; warning?: string }
const a = (text: string, id = `a-${text.slice(0, 8)}`): M => ({ role: "assistant", text, id });
const u = (text: string, id = `u-${text.slice(0, 8)}`): M => ({ role: "user", text, id });
const t = (text: string, id = `t-${text.slice(0, 8)}`): M => ({ role: "tool", text, id });
const ledger = (text: string, id = `l-${text.slice(0, 8)}`): M => ({ role: "ledger", text, id });

describe("attachWarning (sidecar-onto-LAST-assistant)", () => {
  test("plants the warning as a sidecar on the (only) assistant message", () => {
    const msgs: M[] = [u("help me"), a("Sure, let me edit auth.ts."), t("✓ FileEdit")];
    const out = attachWarning(msgs, "claims an edit but no files changed");
    // Length unchanged (re-use the assistant bubble): sidecar, not sibling.
    expect(out.length).toBe(3);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    // The assistant bubble's warning field now carries the caution text.
    expect(out[1]!).toEqual({
      role: "assistant",
      text: "Sure, let me edit auth.ts.",
      id: "a-Sure, le",
      warning: "claims an edit but no files changed",
    });
    // Adjacent entries untouched (no warning leakage into user/tool).
    expect(out[0]!.warning).toBeUndefined();
    expect(out[2]!.warning).toBeUndefined();
  });

  test("sidecars onto the LAST assistant in a multi-turn reply", () => {
    const msgs: M[] = [
      u("fix the bug"),
      a("First I'll look at the file…"),         // turn-1 assistant
      t("FileRead result"),
      a("Fixed it."),                            // turn-2 assistant (final — qualifying)
      t("FileEdit ok"),
      ledger("· observed edited auth.ts"),
    ];
    const out = attachWarning(msgs, "claims success but checks failing");
    // Array length and ordering unchanged — sidecar, not sibling insert.
    expect(out.length).toBe(6);
    expect(out.map((m) => m.role)).toEqual([
      "user", "assistant", "tool", "assistant", "tool", "ledger",
    ]);
    // Only the LAST assistant carries the sidecar. The earlier turn-1
    // assistant already streamed/finalised — its `warning` field is undefined.
    expect(out[1]!.warning).toBeUndefined();
    expect(out[3]!).toEqual({
      role: "assistant",
      text: "Fixed it.",
      id: "a-Fixed it",                          // 8-char slice of "Fixed it."
      warning: "claims success but checks failing",
    });
    // No synthetic `role: "warning"` line was inserted — the array is still
    // 6 messages, not 7.
    expect(out.filter((m) => m.role === "warning")).toHaveLength(0);
  });

  test("falls back to a sibling warning when there's no assistant message", () => {
    // Same fallback policy that the previous placeWarning helper implemented
    // inline: lose inline placement rather than drop the caution entirely.
    const msgs: M[] = [u("ping"), t("read ok"), ledger("· observed read X")];
    const out = attachWarning(msgs, "cautious note");
    expect(out.length).toBe(4);
    // Partial match — the synthesized shape satisfies role/text but T may not
    // declare id/warning as required, so toMatchObject sidesteps the structural
    // mismatch that toEqual would trigger under strict typing.
    expect(out[3]!).toMatchObject({
      role: "warning",
      text: "cautious note",
    });
  });

  test("does not mutate the input array (or any of its messages)", () => {
    // Critical: returns a new array AND a new top-level assistant object so
    // React's keyed reconciliation sees a fresh prop reference and re-renders
    // the bubble with the sidecar visible — without mutating the original.
    const a1 = a("reply");
    const msgs: M[] = [u("hi"), a1];
    const beforeArray = msgs.slice();
    const beforeA1 = { ...a1 };
    const out = attachWarning(msgs, "caution");
    expect(msgs).toEqual(beforeArray);
    expect(a1).toEqual(beforeA1);
    expect(out[1]).not.toBe(a1); // new object identity
    expect(out[1]!.warning).toBe("caution");
  });

  test("preserves every other field on the assistant when adding the sidecar", () => {
    // The mutation is a controlled spread — only `warning` is added, everything
    // else on the assistant bubble (id, text, role) carries through unchanged
    // so React reconciliation doesn't tear down + rebuild the markdown subtree.
    const aWithExtras: M = { role: "assistant", text: "I edited auth.ts.", id: "a-custom-id" };
    const msgs: M[] = [u("hi"), aWithExtras];
    const out = attachWarning(msgs, "claims an edit but no files changed");
    expect(out[1]!).toEqual({
      role: "assistant",
      text: "I edited auth.ts.",
      id: "a-custom-id",                         // unchanged
      warning: "claims an edit but no files changed", // added
    });
  });

  test("a SECOND attachWarning overwrites the previous sidecar (idempotent at most once per run)", () => {
    // The ledger fires once per run, so this is mostly a robustness test: if a
    // future refactor accidentally fires the ledger twice (e.g. during a retry),
    // the second call replaces the warning text instead of stacking sidecars.
    const msgs: M[] = [u("hi"), a("reply")];
    const once = attachWarning(msgs, "first");
    const twice = attachWarning(once, "second");
    expect(twice[1]!.warning).toBe("second");
    expect(twice.length).toBe(2); // no spurious extra bubbles
  });
});
