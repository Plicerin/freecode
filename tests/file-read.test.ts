import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileReadTool } from "../src/tools/file-read";

function tmp(name: string, content: string | Buffer): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "fc-read-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return { dir, path };
}

test("clips a giant single-line (minified JSON) instead of dumping it all", async () => {
  // The reported case: a minified animation JSON — one ~400KB line.
  const huge = '{"frames":[' + '"x",'.repeat(100_000) + '"end"]}';
  const { path } = tmp("plasma.json", huge);
  const r = await FileReadTool.run({ path }, { cwd: "/" });
  expect(r.ok).toBe(true); // no longer a hard failure
  expect(r.output.length).toBeLessThan(5_000); // not the full 400KB
  expect(r.output).toMatch(/\[\+\d+ chars\]/); // clip marker present
  expect(r.output).toMatch(/long lines clipped/);
});

test("reads a large file as a head rather than rejecting it", async () => {
  // > READ_BYTE_CAP (2MB): plasma.json's real problem was a hard 'too large' error.
  const big = "line of text\n".repeat(200_000); // ~2.6MB, many lines
  const { path } = tmp("big.log", big);
  const r = await FileReadTool.run({ path }, { cwd: "/" });
  expect(r.ok).toBe(true);
  expect(r.output).toMatch(/read first 2000000/);
  expect(r.metadata?.truncated).toBe(true);
});

test("defaults a line limit and reports paging", async () => {
  const many = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
  const { path } = tmp("many.txt", many);
  const r = await FileReadTool.run({ path }, { cwd: "/" });
  expect(r.ok).toBe(true);
  expect(r.output).toMatch(/showing lines 1-2000 of 5000/);
  // offset/limit pages further
  const r2 = await FileReadTool.run({ path, offset: 2000, limit: 10 }, { cwd: "/" });
  expect(r2.output).toMatch(/line 2000/);
  expect(r2.output).not.toMatch(/line 1999/);
});

test("small text file reads cleanly with no truncation notice", async () => {
  const { path } = tmp("x.txt", "line1\nline2\n");
  const r = await FileReadTool.run({ path }, { cwd: "/" });
  expect(r.ok).toBe(true);
  expect(r.output).toMatch(/line1/);
  expect(r.output).not.toMatch(/use offset\/limit/);
  expect(r.metadata?.truncated).toBe(false);
});

test("binary file still errors", async () => {
  const { path } = tmp("x.bin", Buffer.from([0x48, 0x00, 0x49]));
  const r = await FileReadTool.run({ path }, { cwd: "/" });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/binary/i);
});
