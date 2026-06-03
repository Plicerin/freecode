import { test, expect } from "bun:test";
import { sanitizeToolPairing } from "../src/agent/sanitize";
import type { ChatMessage } from "../src/providers/types";

function call(id: string, name = "Bash") {
  return { id, name, arguments: {} };
}

// The invariant the providers enforce: every assistant tool_call id is answered
// by a later tool message, and no tool message is an orphan.
function assertPaired(msgs: ChatMessage[]) {
  const declared = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant" && m.toolCalls) for (const c of m.toolCalls) declared.add(c.id);
    if (m.role === "tool") {
      expect(m.toolCallId).toBeDefined();
      expect(declared.has(m.toolCallId!)).toBe(true); // no orphan results
    }
  }
  // every declared call has a result
  for (const m of msgs) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) {
        expect(msgs.some((t) => t.role === "tool" && t.toolCallId === c.id)).toBe(true);
      }
    }
  }
}

test("well-formed history passes through unchanged", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [call("a1")] },
    { role: "tool", toolCallId: "a1", content: "ok" },
    { role: "assistant", content: "done" },
  ];
  const out = sanitizeToolPairing(msgs);
  expect(out).toHaveLength(4);
  assertPaired(out);
});

test("reproduces the 400: a tool_call with no result gets backfilled", () => {
  // Exactly the reported case — assistant calls a tool, then the turn was
  // interrupted, and the NEXT user message follows with no tool result between.
  const msgs: ChatMessage[] = [
    { role: "user", content: "do it" },
    { role: "assistant", content: "", toolCalls: [call("call_rcy0r98yw6Z4Hq3t4F8fi21l")] },
    { role: "user", content: "next thing" }, // <- orphaned call, would 400
  ];
  const out = sanitizeToolPairing(msgs);
  assertPaired(out);
  // the synthetic result is inserted right after the assistant call, before the user msg
  expect(out[2]!.role).toBe("tool");
  expect(out[2]!.toolCallId).toBe("call_rcy0r98yw6Z4Hq3t4F8fi21l");
  expect(out[3]!.role).toBe("user");
});

test("multi-tool turn interrupted partway: only missing calls are backfilled", () => {
  const msgs: ChatMessage[] = [
    { role: "assistant", content: "", toolCalls: [call("a"), call("b"), call("c")] },
    { role: "tool", toolCallId: "a", content: "done a" }, // b and c never ran
  ];
  const out = sanitizeToolPairing(msgs);
  assertPaired(out);
  const toolMsgs = out.filter((m) => m.role === "tool");
  expect(toolMsgs.map((m) => m.toolCallId).sort()).toEqual(["a", "b", "c"]);
  expect(toolMsgs.find((m) => m.toolCallId === "a")!.content).toBe("done a"); // real result kept
});

test("orphan tool message (call summarized away by compaction) is dropped", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "earlier summary…" },
    { role: "tool", toolCallId: "gone", content: "result for a call no longer present" },
    { role: "assistant", content: "hello" },
  ];
  const out = sanitizeToolPairing(msgs);
  assertPaired(out);
  expect(out.some((m) => m.role === "tool")).toBe(false); // dropped
  expect(out).toHaveLength(2);
});

test("duplicate result for the same call is de-duplicated", () => {
  const msgs: ChatMessage[] = [
    { role: "assistant", content: "", toolCalls: [call("a")] },
    { role: "tool", toolCallId: "a", content: "first" },
    { role: "tool", toolCallId: "a", content: "dup" },
  ];
  const out = sanitizeToolPairing(msgs);
  assertPaired(out);
  expect(out.filter((m) => m.role === "tool")).toHaveLength(1);
});

test("is idempotent", () => {
  const msgs: ChatMessage[] = [
    { role: "assistant", content: "", toolCalls: [call("a"), call("b")] },
    { role: "tool", toolCallId: "a", content: "ok" },
    { role: "user", content: "more" },
  ];
  const once = sanitizeToolPairing(msgs);
  const twice = sanitizeToolPairing(once);
  expect(twice).toEqual(once);
  assertPaired(twice);
});
