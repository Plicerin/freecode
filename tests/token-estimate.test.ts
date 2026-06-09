import { test, expect, describe } from "bun:test";
import { estimateTokens, estimateMessagesTokens, trimToFit } from "../src/agent/token-estimate";
import type { ChatMessage } from "../src/providers/types";

describe("estimateTokens", () => {
  test("roughly chars/4, zero for empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("estimateMessagesTokens", () => {
  test("sums system + message content with per-message overhead", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "a".repeat(400) },   // 100
      { role: "assistant", content: "b".repeat(40) }, // 10
    ];
    // 100 + 10 content + 2*4 overhead = 118 (no system)
    expect(estimateMessagesTokens(msgs)).toBe(118);
    // + system of 40 chars = +10
    expect(estimateMessagesTokens(msgs, "s".repeat(40))).toBe(128);
  });

  test("counts tool-call arguments and image allowances", () => {
    const withTool: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "FileRead", arguments: { path: "x" } }] },
    ];
    // overhead 4 + name "FileRead"(8→2) + JSON {"path":"x"}(12→3) = 9
    expect(estimateMessagesTokens(withTool)).toBe(9);

    const withImage: ChatMessage[] = [
      { role: "user", content: "", images: [{ data: "zzz", mediaType: "image/png" }] },
    ];
    expect(estimateMessagesTokens(withImage)).toBe(4 + 1000); // overhead + per-image
  });

  test("a giant message dominates — the overflow signal we rely on", () => {
    const huge: ChatMessage[] = [{ role: "tool", toolCallId: "1", content: "Z".repeat(4_000_000) }];
    expect(estimateMessagesTokens(huge)).toBeGreaterThan(900_000);
  });
});

describe("trimToFit", () => {
  const msg = (n: number, chars: number): ChatMessage => ({ role: "user", content: `m${n}:` + "x".repeat(chars) });
  test("drops oldest middle messages until within budget, keeping first + last", () => {
    const msgs = [msg(0, 400), msg(1, 4000), msg(2, 4000), msg(3, 4000), msg(9, 400)]; // ~100 + 3×1000 + 100 tok
    const { messages, dropped } = trimToFit(msgs, undefined, 600); // budget 600 tok
    expect(dropped).toBeGreaterThan(0);
    expect(estimateMessagesTokens(messages)).toBeLessThanOrEqual(600);
    expect(messages[0]!.content).toMatch(/^m0:/); // first kept
    expect(messages[messages.length - 1]!.content).toMatch(/^m9:/); // last kept
  });
  test("no-op when it already fits", () => {
    const msgs = [msg(0, 40), msg(1, 40)];
    expect(trimToFit(msgs, undefined, 10_000).dropped).toBe(0);
  });
  test("can't shrink below first+last (a single huge message stays)", () => {
    const msgs = [msg(0, 40), msg(1, 4_000_000)];
    const { dropped } = trimToFit(msgs, undefined, 100); // last is huge, only 2 left → can't drop
    expect(dropped).toBe(0);
  });
});
