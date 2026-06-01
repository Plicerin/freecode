import { describe, it, expect } from "bun:test";
import { GlobTool } from "../src/tools/glob";
import { FileReadTool } from "../src/tools/file-read";
import { WebFetchTool } from "../src/tools/web-fetch";
import { FileEditTool } from "../src/tools/file-edit";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

describe("Glob", () => {
  it("finds files by pattern", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-glob-"));
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "b.ts"), "");
    writeFileSync(join(dir, "c.md"), "");
    const r = await GlobTool.run({ pattern: "*.ts" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/a\.ts/);
    expect(r.output).toMatch(/b\.ts/);
    expect(r.output).not.toMatch(/c\.md/);
  });
});

describe("WebFetch", () => {
  it("fetches example.com as markdown (network required)", async () => {
    const r = await WebFetchTool.run({ url: "https://example.com" }, { cwd: process.cwd() });
    if (!r.ok) {
      // offline test environment — skip
      expect(r.error).toBeDefined();
      return;
    }
    expect(r.output).toMatch(/Example Domain/i);
  }, { timeout: 10_000 });
});

describe("FileEdit", () => {
  it("replaces oldText with newText", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-edit-"));
    const p = join(dir, "x.txt");
    writeFileSync(p, "hello world");
    const r = await FileEditTool.run({ path: p, oldText: "hello", newText: "goodbye" }, { cwd: dir });
    expect(r.ok).toBe(true);
    const r2 = await FileReadTool.run({ path: p }, { cwd: dir });
    expect(r2.output).toMatch(/goodbye world/);
  });
  it("errors on missing oldText", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-edit2-"));
    const p = join(dir, "x.txt");
    writeFileSync(p, "hello");
    const r = await FileEditTool.run({ path: p, oldText: "bye", newText: "x" }, { cwd: dir });
    expect(r.ok).toBe(false);
  });
});
