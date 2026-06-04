import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { newSession, appendEvent, readSession } from "../src/session/manager";
import { historyFromEvents } from "../src/session/history";

const iso = () => new Date().toISOString();

test("resume restores the conversation: events round-trip into provider history", () => {
  const cwd = `/freecode-resume-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const s = newSession(cwd);
  try {
    appendEvent(s, { kind: "user", text: "remember the number 42", ts: iso() });
    appendEvent(s, { kind: "assistant", text: "got it, 42", ts: iso() });
    appendEvent(s, { kind: "tool_call", id: "t1", name: "Bash", args: {}, ts: iso() });
    appendEvent(s, { kind: "tool_result", id: "t1", output: "ok", ok: true, ts: iso(), durationMs: 1 });
    appendEvent(s, { kind: "user", text: "what number?", ts: iso() });

    const history = historyFromEvents(readSession(s));
    // user/assistant turns are restored, in order…
    expect(history.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:remember the number 42",
      "assistant:got it, 42",
      "user:what number?",
    ]);
    // …and tool/system events are dropped (keeps the provider message format valid)
    expect(history.some((m) => m.role === "tool")).toBe(false);
    // the prior context (42) is present, so a resumed turn would "remember" it
    expect(history.map((m) => m.content).join(" ")).toContain("42");
  } finally {
    rmSync(dirname(s.path), { recursive: true, force: true });
  }
});
