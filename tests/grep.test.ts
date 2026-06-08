import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool, grepTimeoutMs } from "../src/tools/grep";

// Force the builtin fallback by pointing at a ripgrep binary that doesn't exist.
const grep = createGrepTool({ ripgrepPath: "definitely-not-rg-xyz" });
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-grep-"));
  writeFileSync(join(dir, "a.txt"), "hello world\nfind me here\n");
  writeFileSync(join(dir, "b.txt"), "nothing relevant\n");
});

describe("Grep builtin fallback (no ripgrep)", () => {
  it("finds matches as path:line:content", async () => {
    const r = await grep.run({ pattern: "find me" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect((r.metadata as { engine?: string }).engine).toBe("builtin");
    expect(r.output).toContain("a.txt:2:find me here");
  });

  it("returns (no matches) when nothing matches", async () => {
    const r = await grep.run({ pattern: "zzz_absent_zzz" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("(no matches)");
  });

  it("supports ignoreCase", async () => {
    const r = await grep.run({ pattern: "HELLO", ignoreCase: true }, { cwd: dir });
    expect(r.output).toContain("hello world");
  });

  it("falls back to literal search for an invalid regex", async () => {
    const r = await grep.run({ pattern: "find me (" }, { cwd: dir });
    expect(r.ok).toBe(true); // invalid regex must not throw
  });
});

describe("grepTimeoutMs (search runtime bound)", () => {
  it("defaults to 60s and honors a valid override, ignoring junk/non-positive", () => {
    const prev = process.env.FREECODE_GREP_TIMEOUT_MS;
    try {
      delete process.env.FREECODE_GREP_TIMEOUT_MS;
      expect(grepTimeoutMs()).toBe(60_000);
      process.env.FREECODE_GREP_TIMEOUT_MS = "1500";
      expect(grepTimeoutMs()).toBe(1500);
      process.env.FREECODE_GREP_TIMEOUT_MS = "nonsense";
      expect(grepTimeoutMs()).toBe(60_000);
      process.env.FREECODE_GREP_TIMEOUT_MS = "-5";
      expect(grepTimeoutMs()).toBe(60_000);
    } finally {
      if (prev === undefined) delete process.env.FREECODE_GREP_TIMEOUT_MS;
      else process.env.FREECODE_GREP_TIMEOUT_MS = prev;
    }
  });
});
