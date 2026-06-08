import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobTool, globTimeoutMs } from "../src/tools/glob";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-glob-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "");
  writeFileSync(join(dir, "src", "b.ts"), "");
  writeFileSync(join(dir, "readme.md"), "");
});

describe("GlobTool", () => {
  it("finds files matching a pattern", async () => {
    const r = await GlobTool.run({ pattern: "src/*.ts" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output.split("\n").sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns (no matches) when nothing matches", async () => {
    const r = await GlobTool.run({ pattern: "**/*.py" }, { cwd: dir });
    expect(r.output).toBe("(no matches)");
  });
});

describe("globTimeoutMs (walk wait bound)", () => {
  it("defaults to 30s and honors a valid override, ignoring junk/non-positive", () => {
    const prev = process.env.FREECODE_GLOB_TIMEOUT_MS;
    try {
      delete process.env.FREECODE_GLOB_TIMEOUT_MS;
      expect(globTimeoutMs()).toBe(30_000);
      process.env.FREECODE_GLOB_TIMEOUT_MS = "5000";
      expect(globTimeoutMs()).toBe(5000);
      process.env.FREECODE_GLOB_TIMEOUT_MS = "junk";
      expect(globTimeoutMs()).toBe(30_000);
      process.env.FREECODE_GLOB_TIMEOUT_MS = "0";
      expect(globTimeoutMs()).toBe(30_000);
    } finally {
      if (prev === undefined) delete process.env.FREECODE_GLOB_TIMEOUT_MS;
      else process.env.FREECODE_GLOB_TIMEOUT_MS = prev;
    }
  });
});
