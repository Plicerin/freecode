// /resume must restore the REAL provider-format context — tool_use/tool_result
// pairs and any compaction summary — not the text-only rebuild that dropped ~95%
// of a coding session (all the tool I/O). This pins the persist/restore helpers.
import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConversationState, readConversationState, type Session } from "../src/session/manager";
import type { ChatMessage } from "../src/providers/types";

function tempSession(): Session {
  const dir = mkdtempSync(join(tmpdir(), "oc-state-"));
  return { id: "sess1", cwd: dir, path: join(dir, "sess1.jsonl") };
}

describe("conversation state (full-context resume)", () => {
  test("round-trips provider-format messages including tool pairs", () => {
    const s = tempSession();
    const msgs: ChatMessage[] = [
      { role: "user", content: "read the file" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "FileRead", arguments: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "1", content: "the full file contents here" },
      { role: "assistant", content: "It defines X." },
    ];
    writeConversationState(s, msgs);
    const back = readConversationState(s);
    expect(back).toEqual(msgs);
    // The tool result survives — exactly the context historyFromEvents used to drop.
    expect(back!.some((m) => m.role === "tool" && m.content === "the full file contents here")).toBe(true);
    expect(back!.find((m) => m.role === "assistant" && m.toolCalls)!.toolCalls![0]!.name).toBe("FileRead");
  });

  test("latest write wins (overwrite, not append)", () => {
    const s = tempSession();
    writeConversationState(s, [{ role: "user", content: "one" }]);
    writeConversationState(s, [{ role: "user", content: "two" }, { role: "assistant", content: "2" }]);
    expect(readConversationState(s)).toEqual([{ role: "user", content: "two" }, { role: "assistant", content: "2" }]);
  });

  test("returns undefined for a session saved before conversation-state existed", () => {
    const s = tempSession(); // no state file written
    expect(readConversationState(s)).toBeUndefined();
  });
});
