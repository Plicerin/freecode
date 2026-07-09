// Models very commonly emit FileEdit with the diff under a `diff` field, and/or
// put the path only in the diff's +++/--- header. The old schema rejected both
// ("You gave a path but no edit") — a perfectly good patch killed on a naming nit.
// These guard the `diff` alias and path-from-header derivation.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEditTool, pathFromDiffHeader, normalizeHunkCounts } from "../src/tools/file-edit";

describe("pathFromDiffHeader", () => {
  test("prefers +++ , strips a/ b/ and trailing tab", () => {
    expect(pathFromDiffHeader("--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@")).toBe("src/x.ts");
    expect(pathFromDiffHeader("--- src/x.ts\t2020\n+++ src/x.ts\t2020\n@@")).toBe("src/x.ts");
  });
  test("falls back to --- when +++ is /dev/null; null when no header", () => {
    expect(pathFromDiffHeader("--- a/gone.ts\n+++ /dev/null\n@@")).toBe("gone.ts");
    expect(pathFromDiffHeader("no header here")).toBeNull();
  });
});

describe("FileEdit accepts a `diff` alias and derives the path", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-fed-"));
    const file = join(dir, "config.txt");
    writeFileSync(file, "line one\nline two\nline three\n");
    return { dir, file };
  };

  test("`diff` field (alias for unifiedDiff) + path in arg applies", async () => {
    const { dir, file } = setup();
    const diff = `--- config.txt\n+++ config.txt\n@@ -1,3 +1,3 @@\n line one\n-line two\n+LINE TWO\n line three\n`;
    const r = await FileEditTool.run({ path: "config.txt", diff } as never, { cwd: dir } as never);
    expect(r.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("LINE TWO");
  });

  test("NO path arg — derived from the diff header", async () => {
    const { dir, file } = setup();
    const diff = `--- a/config.txt\n+++ b/config.txt\n@@ -1,3 +1,3 @@\n line one\n line two\n-line three\n+LINE THREE\n`;
    const r = await FileEditTool.run({ diff } as never, { cwd: dir } as never);
    expect(r.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("LINE THREE");
  });

  test("oldText/newText still works and still requires a path", async () => {
    const { dir, file } = setup();
    const r = await FileEditTool.run({ path: "config.txt", oldText: "line one", newText: "LINE ONE" } as never, { cwd: dir } as never);
    expect(r.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("LINE ONE");
  });
});

describe("normalizeHunkCounts (recompute wrong @@ header counts from the body)", () => {
  test("fixes a wrong added-line count", () => {
    const bad = "@@ -1,1 +1,2 @@\n alpha\n+one\n+two"; // header says +1,2, body adds 2 (=3 new)
    expect(normalizeHunkCounts(bad).split("\n")[0]).toBe("@@ -1,1 +1,3 @@");
  });
  test("no-op on an already-correct header (idempotent)", () => {
    const ok = "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma";
    expect(normalizeHunkCounts(ok)).toBe(ok);
  });
  test("handles multiple hunks and preserves the section text after @@", () => {
    const d = "@@ -1,1 +1,1 @@ func foo()\n-a\n+A\n@@ -5,1 +5,1 @@\n-b\n+B";
    const lines = normalizeHunkCounts(d).split("\n");
    expect(lines[0]).toBe("@@ -1,1 +1,1 @@ func foo()"); // counts right, section text kept
    expect(lines[3]).toBe("@@ -5,1 +5,1 @@");
  });
});

describe("FileEdit tolerates a wrong hunk-header count (the reported bug)", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-fed2-"));
    const file = join(dir, "cockpit.ts");
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    return { dir, file };
  };

  test("a diff whose @@ header count is wrong now APPLIES instead of throwing", async () => {
    const { dir, file } = setup();
    // Header claims "+1,2" but the body inserts two lines under one context line.
    const diff = "--- a/cockpit.ts\n+++ b/cockpit.ts\n@@ -1,1 +1,2 @@\n alpha\n+inserted-one\n+inserted-two\n";
    const r = await FileEditTool.run({ path: "cockpit.ts", diff } as never, { cwd: dir } as never);
    expect(r.ok).toBe(true);
    const out = readFileSync(file, "utf8");
    expect(out).toContain("inserted-one");
    expect(out).toContain("inserted-two");
  });

  test("a genuinely unapplicable diff returns a helpful error, not a raw library throw", async () => {
    const { dir } = setup();
    // Context line doesn't exist in the file → can't apply; must be a clear message.
    const diff = "--- a/cockpit.ts\n+++ b/cockpit.ts\n@@ -1,1 +1,1 @@\n-nonexistent-line\n+replacement\n";
    const r = await FileEditTool.run({ path: "cockpit.ts", diff } as never, { cwd: dir } as never);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/oldText|re-read|didn't apply|malformed/i);
    expect(r.error).not.toMatch(/Added line count did not match|Unknown line/); // no cryptic library internals
  });
});
