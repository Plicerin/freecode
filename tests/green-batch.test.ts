import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileReadTool } from "../src/tools/file-read";
import { extractAttachments } from "../src/agent/attachments";
import { contextWindowFor } from "../src/agent/pricing";

describe("FileRead binary detection", () => {
  it("errors on a file with NUL bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-bin-"));
    const f = join(dir, "x.bin");
    writeFileSync(f, Buffer.from([0x48, 0x00, 0x49]));
    const r = await FileReadTool.run({ path: f }, { cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/binary/i);
  });
  it("still reads normal text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-txt-"));
    const f = join(dir, "x.txt");
    writeFileSync(f, "line1\nline2\n");
    const r = await FileReadTool.run({ path: f }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/line1/);
  });
});

describe("@path text-file inclusion", () => {
  it("inlines a referenced text file, ignores @mentions, skips binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-at-"));
    writeFileSync(join(dir, "notes.txt"), "hello from notes");
    writeFileSync(join(dir, "blob.dat"), Buffer.from([1, 0, 2]));
    const r = extractAttachments("read @notes.txt and @nonexistent and @blob.dat cc @someone", dir);
    expect(r.files.length).toBe(1);
    expect(r.files[0]!.content).toBe("hello from notes");
    expect(r.notes.some((n) => /skipped binary/.test(n))).toBe(true);
  });
});

describe("contextWindowFor", () => {
  it("maps models to windows", () => {
    expect(contextWindowFor("gpt-4o")).toBe(128_000);
    expect(contextWindowFor("gpt-4.1")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-4-5")).toBe(200_000);
    expect(contextWindowFor("o3-mini")).toBe(200_000);
    expect(contextWindowFor("something-unknown")).toBe(128_000);
  });
});
