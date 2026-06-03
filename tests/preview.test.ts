import { test, expect } from "bun:test";
import { previewToolResult } from "../src/tui/preview";

test("clips a single huge line (minified JSON) to a glance", () => {
  const oneLine = '{"colors":{' + '"x":"#FFB41E",'.repeat(5000) + "}}";
  const out = previewToolResult(oneLine);
  expect(out.length).toBeLessThan(300); // not the whole ~70KB blob
  expect(out.endsWith("…")).toBe(true);
});

test("shows first N lines and a '+more' tail for long multi-line output", () => {
  const many = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
  const out = previewToolResult(many);
  expect(out).toMatch(/row 0/);
  expect(out).toMatch(/row 7/);
  expect(out).not.toMatch(/row 8\b/); // beyond the 8-line head
  expect(out).toMatch(/\+42 more lines/);
});

test("short output passes through unchanged", () => {
  const small = "ok\ndone";
  expect(previewToolResult(small)).toBe("ok\ndone");
});
