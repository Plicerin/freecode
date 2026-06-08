import { test, expect, describe } from "bun:test";
import { estimateTokens, estimateMessagesTokens } from "../src/agent/token-estimate";
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
