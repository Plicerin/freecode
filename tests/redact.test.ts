import { test, expect } from "bun:test";
import { redactSecrets } from "../src/utils/redact";

test("redacts an OpenAI project key (the sk-proj- format that leaked)", () => {
  // SYNTHETIC key — same shape, not a real secret (never commit a live key).
  const out = redactSecrets("OPENAI_API_KEY  sk-proj-EXAMPLEdummytestkey000000000000000000000000abc");
  expect(out.count).toBe(1);
  expect(out.text).not.toMatch(/sk-proj-EXAMPLE/);
  expect(out.text).toMatch(/\[REDACTED:openai-key\]/);
  expect(out.text).toMatch(/OPENAI_API_KEY/); // var name preserved, value gone
});

test("redacts multiple distinct key formats in one blob", () => {
  const blob = [
    "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
    "GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "GOOGLE=AIzaSyAbc123def456ghi789jkl012mno345pqr",
    "HF=hf_abcdefghijklmnopqrstuvwxyz0123",
    "NIM=nvapi-abcdefghijklmnopqrstuvwxyz",
  ].join("\n");
  const out = redactSecrets(blob);
  expect(out.count).toBeGreaterThanOrEqual(5);
  expect(out.text).not.toMatch(/sk-ant-api03-abc/);
  expect(out.text).not.toMatch(/ghp_abc/);
  expect(out.text).not.toMatch(/AIzaSyAbc/);
  expect(out.text).not.toMatch(/hf_abc/);
});

test("leaves ordinary output untouched", () => {
  const txt = "Build succeeded in 1.2s\n3 files changed\nhttp://localhost:8000";
  const out = redactSecrets(txt);
  expect(out.count).toBe(0);
  expect(out.text).toBe(txt);
});

test("placeholder text (not a real key) is left alone", () => {
  const out = redactSecrets("ANTHROPIC_API_KEY  <your-anthropic-api-key>");
  expect(out.count).toBe(0);
});
