// Config JSON was written with a plain writeFileSync (read-modify-write). A crash or
// a concurrent second instance mid-write leaves torn JSON, and every reader fail-softs
// to {} — silently wiping the user's settings/grants. writeFileAtomic writes a temp
// sibling then renames over the target, so the old file survives a failed write.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/utils/atomic";

describe("writeFileAtomic", () => {
  let dir = "";
  afterEach(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } });

  test("writes the file, creating missing parent dirs", () => {
    dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const p = join(dir, "sub", "deep", "config.json");
    writeFileAtomic(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
  });

  test("overwrites in place and leaves no .tmp behind", () => {
    dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]); // no temp/torn artifact
  });
});
