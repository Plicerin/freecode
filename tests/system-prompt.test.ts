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
