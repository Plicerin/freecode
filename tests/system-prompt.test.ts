import { test, expect } from "bun:test";
import { toolListToSystemPrompt } from "../src/tools/registry";

// Guards the operational guidance from being accidentally dropped. These are
// the behaviours that make freecode effective, not just functional.
test("system prompt carries the Phase 1 tools & shell discipline", () => {
  const p = toolListToSystemPrompt([]);
  // non-interactive shell habit (the npm-create-astro hang lesson)
  expect(p).toMatch(/NON-INTERACTIVE/i);
  expect(p).toMatch(/--yes/);
  // prefer dedicated tools over shell equivalents
  expect(p).toMatch(/Grep to search/i);
  // read-before-edit
  expect(p).toMatch(/Read a file before you edit/i);
  // verify-before-claiming (the identity)
  expect(p).toMatch(/seen it work/i);
});

test("system prompt carries the Phase 2 editing craft", () => {
  const p = toolListToSystemPrompt([]);
  expect(p).toMatch(/Match the surrounding code/i);
  expect(p).toMatch(/smallest change/i);
  expect(p).toMatch(/Leave no TODOs/i);
});

test("system prompt carries the Phase 3 approach & communication guidance", () => {
  const p = toolListToSystemPrompt([]);
  expect(p).toMatch(/think first/i);
  expect(p).toMatch(/exactly what was asked/i);
  expect(p).toMatch(/path:line/i);
});

test("system prompt carries the four operating principles (default behaviour)", () => {
  const p = toolListToSystemPrompt([]);
  // 1. Think before coding — surface interpretations, ask vs. guess, stop when confused.
  expect(p).toMatch(/Think before coding/i);
  expect(p).toMatch(/ask rather than guess/i);
  // 2. Simplicity first — the sharp "200 lines could be 50" test.
  expect(p).toMatch(/Simplicity first/i);
  expect(p).toMatch(/200 lines could be 50/i);
  // 3. Surgical changes — mention pre-existing dead code, don't delete it.
  expect(p).toMatch(/Surgical changes/i);
  expect(p).toMatch(/mention it — don't delete it/i);
  expect(p).toMatch(/trace to the request/i);
  // 4. Goal-driven — reproduce a bug with a test first.
  expect(p).toMatch(/Goal-driven execution/i);
  expect(p).toMatch(/test that reproduces it/i);
});

test("blanket keep-working autonomy is scoped to /goal, not the interactive default", () => {
  const p = toolListToSystemPrompt([]);
  expect(p).toMatch(/Interactive by default/i);
  expect(p).toMatch(/autonomy is for \/goal/i);
});
