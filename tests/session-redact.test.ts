// The write-boundary fix: redactSecrets was only applied to tool OUTPUT, so a
// FileWrite of a .env, a pasted key, or a secret the model echoed landed in
// cleartext in the session log (.jsonl) and .state.json under ~/.freecode. appendEvent
// / writeConversationState now scrub every persisted string.
import { test, expect, describe, afterEach } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, appendEvent, readSession } from "../src/session/manager";
import { projectDir } from "../src/utils/paths";

describe("session-log redaction (persist boundary)", () => {
  let cwd = "";
  afterEach(() => { if (cwd) { try { rmSync(projectDir(cwd), { recursive: true, force: true }); } catch { /* ignore */ } } });

  test("a secret in FileWrite content is redacted in the persisted tool_call", () => {
    cwd = mkdtempSync(join(tmpdir(), "sess-redact-"));
    const s = newSession(cwd);
    const secret = "sk-" + "proj-" + "x".repeat(40); // assembled so no key literal sits in source
    appendEvent(s, { kind: "tool_call", id: "1", name: "FileWrite", args: { path: ".env", content: `OPENAI_API_KEY=${secret}` }, ts: "2026-01-01T00:00:00Z" });
    const call = readSession(s).find((e) => e.kind === "tool_call");
    const stored = JSON.stringify(call);
    expect(stored).not.toContain(secret);
    expect(stored).toContain("[REDACTED:openai-key]");
  });

  test("a pasted key in a user prompt is redacted in the log", () => {
    cwd = mkdtempSync(join(tmpdir(), "sess-redact-"));
    const s = newSession(cwd);
    const secret = "sk-" + "ant-" + "y".repeat(30);
    appendEvent(s, { kind: "user", text: `my key is ${secret}`, ts: "2026-01-01T00:00:00Z" });
    const user = readSession(s).find((e) => e.kind === "user");
    expect(JSON.stringify(user)).not.toContain(secret);
  });
});
