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
    expect(r.error).toMatch(/no unique match/i);
  });
});

describe("FileEdit flexible (indentation-tolerant) matching", () => {
  it("matches a block whose indentation differs from the file, editing the real lines", async () => {
    writeFileSync(f, "function g() {\n            const a = 1;\n            return a;\n}\n");
    const r = await FileEditTool.run({
      path: f,
      oldText: "        const a = 1;\n        return a;", // 8-space indent vs the file's 12
      newText: "            const a = 2;\n            return a;",
    }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect((r.metadata as { flexible?: boolean }).flexible).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("function g() {\n            const a = 2;\n            return a;\n}\n");
  });

  it("tolerates a blank line with trailing whitespace (the real failure case)", async () => {
    writeFileSync(f, "  a();\n\n  b();\n"); // truly-empty middle line
    const r = await FileEditTool.run({
      path: f,
      oldText: "  a();\n      \n  b();", // middle line carries trailing spaces
      newText: "  a();\n  c();\n  b();",
    }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("  a();\n  c();\n  b();\n");
  });

  it("REFUSES a flexible match when the normalized block is ambiguous", async () => {
    writeFileSync(f, "  x = 1\n  y = 2\n\n    x = 1\n    y = 2\n"); // same block at two indents
    const r = await FileEditTool.run({ path: f, oldText: "x = 1\ny = 2", newText: "z" }, { cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no unique match/i);
  });

  it("prefers an EXACT match (flexible flag off) when the text matches verbatim", async () => {
    writeFileSync(f, "  keep();\n  edit();\n");
    const r = await FileEditTool.run({ path: f, oldText: "  edit();", newText: "  edited();" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect((r.metadata as { flexible?: boolean }).flexible).toBe(false);
  });
});
