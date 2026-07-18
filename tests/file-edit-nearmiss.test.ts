// FileEdit's "oldText not found" was a dead-end: in the crash session the model
// hit it 8× (a big block reconstructed with one line off, or a stale snippet) and
// abandoned FileEdit for raw `node -e` line-surgery — which truncated the file.
// These tests pin the near-miss diagnostic (point at the diverging line) and the
// ambiguous-vs-not-found split, so the model corrects and retries FileEdit.
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closestRegion, flexMatchCount, flexLocate, FileEditTool } from "../src/tools/file-edit";

describe("closestRegion (near-miss locator)", () => {
  const file = "function foo() {\n  const x = computeValue(a, b);\n  return x + 1;\n}\n";
  it("finds the diverging line when a block is one token off", () => {
    const old = "function foo() {\n  const x = computeValue(a, c);\n  return x + 1;\n}";
    const r = closestRegion(file, old)!;
    expect(r.start).toBe(1);
    expect(r.end).toBe(4);
    expect(r.diffLine).toBe(2);
    expect(r.oldLine).toBe("const x = computeValue(a, c);");
    expect(r.fileLine).toBe("const x = computeValue(a, b);");
  });
  it("returns null when nothing is even loosely similar", () => {
    expect(closestRegion(file, "totally\nunrelated\ncontent\nhere")).toBeNull();
  });
  it("returns null for an exact (ambiguous-elsewhere) window — not a real divergence", () => {
    expect(closestRegion(file, "  return x + 1;\n}")).toBeNull();
  });
});

describe("flexMatchCount", () => {
  const file = "  foo();\n  bar();\n      foo();\n      bar();\n";
  it("counts whitespace-flexible matches (0 / 1 / many)", () => {
    expect(flexMatchCount(file, "nope();\ngone();")).toBe(0);
    expect(flexMatchCount("a\n  target();\nb\n", "target();")).toBe(1);
    expect(flexMatchCount(file, "foo();\nbar();")).toBe(2); // both blocks, differing indent
  });
});

describe("FileEdit failure guidance", () => {
  let dir: string, f: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "oc-nm-")); f = join(dir, "code.ts"); });

  it("not-found points at the diverging line and steers away from node -e", async () => {
    writeFileSync(f, "function foo() {\n  const x = computeValue(a, b);\n  return x + 1;\n}\n");
    const r = await FileEditTool.run(
      { path: f, oldText: "  const x = computeValue(a, c);\n  return x + 1;", newText: "  return 0;" },
      { cwd: dir },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/closest match is lines/i);
    expect(r.error).toMatch(/computeValue\(a, b\)/); // shows what the file actually has
    expect(r.error).toMatch(/node -e/); // explicit "don't line-surgery" steer
  });

  it("ambiguous match says SEVERAL places / replaceAll, not 'not found'", async () => {
    writeFileSync(f, "  foo();\n  bar();\n      foo();\n      bar();\n");
    const r = await FileEditTool.run({ path: f, oldText: "foo();\nbar();", newText: "baz();" }, { cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SEVERAL places/i);
    expect(r.error).toMatch(/replaceAll/);
  });

  it("still auto-applies a whitespace/indentation-only drift (no regression)", async () => {
    writeFileSync(f, "if (x) {\n        doThing();\n}\n");
    const r = await FileEditTool.run(
      { path: f, oldText: "if (x) {\n  doThing();\n}", newText: "if (x) {\n  doOther();\n}" },
      { cwd: dir },
    );
    expect(r.ok).toBe(true);
    expect(flexLocate("if (x) {\n        doThing();\n}", "if (x) {\n  doThing();\n}")).not.toBeNull();
  });
});
