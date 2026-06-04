import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEditTool } from "../src/tools/file-edit";

function tmp(name: string, content: string) {
  const dir = mkdtempSync(join(tmpdir(), "fc-edit-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("edits a CRLF file with LF oldText (the Windows failure that broke every edit)", async () => {
  // File on disk uses Windows line endings…
  const path = tmp("nav.js", "function go() {\r\n  return 1;\r\n}\r\n");
  // …but the model's oldText uses LF (as models emit).
  const r = await FileEditTool.run({ path, oldText: "function go() {\n  return 1;\n}", newText: "function go() {\n  return 2;\n}" }, { cwd: "/" });
  expect(r.ok).toBe(true);
  const after = readFileSync(path, "utf8");
  expect(after).toContain("return 2;");
  expect(after).toContain("\r\n"); // CRLF preserved on write
  expect(after).not.toContain("\n\n"); // not silently converted to LF-only
});

test("tolerates a copied FileRead line-number gutter in oldText", async () => {
  const path = tmp("a.txt", "alpha\nbeta\ngamma\n");
  // model pasted numbered output: "     2\tbeta"
  const r = await FileEditTool.run({ path, oldText: "     2\tbeta", newText: "BETA" }, { cwd: "/" });
  expect(r.ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("alpha\nBETA\ngamma\n");
});

test("newText containing $ is inserted literally (no replace-pattern mangling)", async () => {
  const path = tmp("p.js", "const price = OLD;\n");
  const r = await FileEditTool.run({ path, oldText: "OLD", newText: "$amount" }, { cwd: "/" });
  expect(r.ok).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("const price = $amount;");
});

test("a genuinely absent oldText still fails honestly", async () => {
  const path = tmp("x.txt", "hello\n");
  const r = await FileEditTool.run({ path, oldText: "nonexistent", newText: "y" }, { cwd: "/" });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not found/i);
});
