// Models very commonly emit FileEdit with the diff under a `diff` field, and/or
// put the path only in the diff's +++/--- header. The old schema rejected both
// ("You gave a path but no edit") — a perfectly good patch killed on a naming nit.
// These guard the `diff` alias and path-from-header derivation.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEditTool, pathFromDiffHeader } from "../src/tools/file-edit";

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
