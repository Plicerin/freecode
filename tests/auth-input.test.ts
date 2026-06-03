import { test, expect } from "bun:test";
import { applyHiddenInput } from "../src/commands/auth";

test("strips bracketed-paste wrappers so the key isn't corrupted", () => {
  // This is the actual bug: Windows Terminal wraps pastes in ␛[200~ … ␛[201~.
  const r = applyHiddenInput("", "\x1b[200~sk-ant-test123\x1b[201~");
  expect(r.buf).toBe("sk-ant-test123");
  expect(r.submit).toBe(false);
  expect(r.echo).toBe("*".repeat("sk-ant-test123".length)); // masked
});

test("handles ESC-less bracketed-paste (ESC swallowed by the terminal)", () => {
  const r = applyHiddenInput("", "[200~sk-xyz[201~");
  expect(r.buf).toBe("sk-xyz");
});

test("Enter ends the line and submits", () => {
  const r = applyHiddenInput("sk-abc", "\r");
  expect(r.submit).toBe(true);
  expect(r.buf).toBe("sk-abc");
});

test("paste followed by Enter in one chunk submits the clean key", () => {
  const r = applyHiddenInput("", "sk-live-key\n");
  expect(r.buf).toBe("sk-live-key");
  expect(r.submit).toBe(true);
});

test("typed characters accumulate and each echoes one asterisk", () => {
  let r = applyHiddenInput("", "a");
  expect(r.buf).toBe("a");
  expect(r.echo).toBe("*");
  r = applyHiddenInput(r.buf, "b");
  expect(r.buf).toBe("ab");
});

test("backspace removes a char and rubs out its asterisk", () => {
  const r = applyHiddenInput("abc", "\x7f");
  expect(r.buf).toBe("ab");
  expect(r.echo).toBe("\b \b");
});

test("stray arrow-key escape sequences are ignored, not stored", () => {
  const r = applyHiddenInput("", "\x1b[A\x1b[B");
  expect(r.buf).toBe("");
});
