import { test, expect } from "bun:test";
import { redactSecrets } from "../src/utils/redact";

// Synthetic keys are ASSEMBLED AT RUNTIME from fragments so no secret-shaped
// literal ever sits in this source file — otherwise GitHub secret scanning (and
// push protection) flags the fixtures as real keys. They still match the
// redaction patterns at runtime, which is what we're testing.
const body = (n: number) => "x".repeat(n);
const FAKE = {
  openai: "sk-" + "proj-" + body(40),
  anthropic: "sk-" + "ant-" + body(30),
  github: "gh" + "p_" + body(36),
  google: "AI" + "za" + body(35),
  hf: "h" + "f_" + body(24),
  nvidia: "nv" + "api-" + body(24),
};

test("redacts an OpenAI project key (the sk-proj- format that leaked)", () => {
  const out = redactSecrets(`OPENAI_API_KEY  ${FAKE.openai}`);
  expect(out.count).toBe(1);
  expect(out.text).not.toContain(FAKE.openai);
  expect(out.text).toMatch(/\[REDACTED:openai-key\]/);
  expect(out.text).toMatch(/OPENAI_API_KEY/); // var name preserved, value gone
});

test("redacts multiple distinct key formats in one blob", () => {
  const blob = [
    `ANTHROPIC_API_KEY=${FAKE.anthropic}`,
    `GH=${FAKE.github}`,
    `GOOGLE=${FAKE.google}`,
    `HF=${FAKE.hf}`,
    `NIM=${FAKE.nvidia}`,
  ].join("\n");
  const out = redactSecrets(blob);
  expect(out.count).toBeGreaterThanOrEqual(5);
  for (const v of Object.values(FAKE)) expect(out.text).not.toContain(v);
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
