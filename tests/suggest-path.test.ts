// When a model sends a slightly-wrong path (a stray space — "system s" for
// "systems" — or a misspelling), "File not found" gives it nothing to correct
// with, so it re-sends the same wrong path until the failure circuit-breaker
// trips. suggestPath names the closest REAL path so the model self-corrects.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestPath } from "../src/tools/suggest-path";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sp-"));
  mkdirSync(join(root, "port", "systems"), { recursive: true });
  writeFileSync(join(root, "port", "systems", "river.py"), "x");
  writeFileSync(join(root, "port", "main.py"), "x");
  return root;
}

describe("suggestPath", () => {
  test("fixes a stray space in a directory component (the reported bug)", () => {
    const root = fixture();
    expect(suggestPath(join(root, "port", "system s", "river.py"))).toBe(join(root, "port", "systems", "river.py"));
  });

  test("fixes a misspelled filename", () => {
    const root = fixture();
    expect(suggestPath(join(root, "port", "systems", "rivr.py"))).toBe(join(root, "port", "systems", "river.py"));
  });

  test("no suggestion when the path already exists", () => {
    const root = fixture();
    expect(suggestPath(join(root, "port", "systems", "river.py"))).toBeNull();
  });

  test("no suggestion when nothing is close (not a typo, a wrong guess)", () => {
    const root = fixture();
    expect(suggestPath(join(root, "port", "systems", "enemy_ai_controller.py"))).toBeNull();
  });

  test("a corrected directory but a genuinely-absent file → no false suggestion", () => {
    const root = fixture();
    // "system s" corrects to "systems", but "collision.py" isn't there → don't invent it
    expect(suggestPath(join(root, "port", "system s", "collision.py"))).toBeNull();
  });

  test("a relative path is left alone (nothing reliable to walk from)", () => {
    expect(suggestPath("port/system s/river.py")).toBeNull();
  });
});
