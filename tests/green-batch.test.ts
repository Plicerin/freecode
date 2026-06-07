import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileReadTool } from "../src/tools/file-read";
import { extractAttachments } from "../src/agent/attachments";
import { contextWindowFor, priceFor } from "../src/agent/pricing";

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
  it("maps models to windows (verified against provider docs, 2026-06)", () => {
    expect(contextWindowFor("gpt-4o")).toBe(128_000);
    expect(contextWindowFor("gpt-4.1")).toBe(1_000_000);
    expect(contextWindowFor("o3-mini")).toBe(200_000);
    expect(contextWindowFor("something-unknown")).toBe(128_000);
    // OpenAI 2026 lineup (verified developers.openai.com)
    expect(contextWindowFor("gpt-5.5")).toBe(1_050_000);
    expect(contextWindowFor("gpt-5.4")).toBe(1_050_000);
    expect(contextWindowFor("gpt-5.4-mini")).toBe(400_000);
    // Anthropic is version-specific: only Opus 4.6+ and Sonnet 4.6 are 1M.
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(1_000_000); // the bug we fixed
    expect(contextWindowFor("claude-opus-4-8")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-4-5")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-5")).toBe(200_000);
    expect(contextWindowFor("claude-haiku-4-5")).toBe(200_000);
  });

  it("FREECODE_CONTEXT_WINDOW overrides the table", () => {
    process.env.FREECODE_CONTEXT_WINDOW = "750000";
    try {
      expect(contextWindowFor("claude-haiku-4-5")).toBe(750_000);
    } finally {
      delete process.env.FREECODE_CONTEXT_WINDOW;
    }
  });
});

describe("priceFor (Anthropic verified 2026-06)", () => {
  it("Anthropic pricing is version-specific", () => {
    // Opus 4.5–4.8 dropped to $5/$25; 4.1/4.0 stay $15/$75.
    expect(priceFor("claude-opus-4-8")).toMatchObject({ input: 5, output: 25 });
    expect(priceFor("claude-opus-4-5")).toMatchObject({ input: 5, output: 25 });
    expect(priceFor("claude-opus-4-1")).toMatchObject({ input: 15, output: 75 });
    expect(priceFor("claude-sonnet-4-6")).toMatchObject({ input: 3, output: 15 });
    expect(priceFor("claude-haiku-4-5")).toMatchObject({ input: 1, output: 5 });
  });

  it("OpenAI GPT-5.x pricing (verified developers.openai.com)", () => {
    expect(priceFor("gpt-5.5")).toMatchObject({ input: 5, output: 30, cacheRead: 0.5 });
    expect(priceFor("gpt-5.4")).toMatchObject({ input: 2.5, output: 15, cacheRead: 0.25 });
  });

  it("Gemini pricing — version-aware, base tier (verified ai.google.dev)", () => {
    expect(priceFor("gemini-2.5-pro")).toMatchObject({ input: 1.25, output: 10 }); // was wrongly $5 out
    expect(priceFor("gemini-2.5-flash")).toMatchObject({ input: 0.3, output: 2.5 });
    expect(priceFor("gemini-2.5-flash-lite")).toMatchObject({ input: 0.1, output: 0.4 });
    expect(priceFor("gemini-3.5-flash")).toMatchObject({ input: 1.5, output: 9 });
    expect(priceFor("gemini-3.1-flash-lite")).toMatchObject({ input: 0.25, output: 1.5 });
    expect(priceFor("gemini-3.1-pro-preview")).toMatchObject({ input: 2, output: 12 });
    expect(priceFor("gemini-2.0-flash")).toMatchObject({ input: 0.1, output: 0.4 });
  });
});

describe("@path trailing punctuation", () => {
  it("resolves @file.png: and @file.txt? despite trailing punctuation", () => {
    const { mkdtempSync, writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "oc-punct-"));
    writeFileSync(join(dir, "a.txt"), "hi");
    const r = extractAttachments("look at @a.txt: now and @a.txt?", dir);
    expect(r.files.length).toBeGreaterThanOrEqual(1);
    expect(r.files[0]!.content).toBe("hi");
  });
});
