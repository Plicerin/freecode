import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { FileEditTool } from "../src/tools/file-edit";

let dir: string, f: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-edit-"));
  f = join(dir, "x.txt");
  writeFileSync(f, "alpha\nbeta\ngamma\n");
});

describe("FileEdit", () => {
  it("applies a unified diff", async () => {
    const patch = createPatch("x.txt", "alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
    const r = await FileEditTool.run({ path: f, unifiedDiff: patch }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("replaces a unique oldText", async () => {
    const r = await FileEditTool.run({ path: f, oldText: "beta", newText: "BETA" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("refuses a non-unique oldText unless replaceAll", async () => {
    writeFileSync(f, "x\nx\nx\n");
    const r = await FileEditTool.run({ path: f, oldText: "x", newText: "y" }, { cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not unique/i);
    const r2 = await FileEditTool.run({ path: f, oldText: "x", newText: "y", replaceAll: true }, { cwd: dir });
    expect(r2.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("y\ny\ny\n");
  });

  it("errors when oldText is absent", async () => {
    const r = await FileEditTool.run({ path: f, oldText: "nope", newText: "z" }, { cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no match/i);
  });
});
