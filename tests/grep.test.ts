import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool } from "../src/tools/grep";

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
