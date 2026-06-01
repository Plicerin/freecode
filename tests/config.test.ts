import { describe, it, expect } from "bun:test";
import { loadJsoncSettings } from "../src/config/settings-jsonc";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadJsoncSettings", () => {
  it("parses JSONC with comments and trailing commas", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    const p = join(dir, "settings.json");
    writeFileSync(
      p,
      `{
        // a comment
        "model": "gpt-4o",
        "permissionMode": "auto", /* block comment */
        "theme": "dark",
        "maxTurns": 30,
      }`,
    );
    const s = loadJsoncSettings(p);
    expect(s.model).toBe("gpt-4o");
    expect(s.permissionMode).toBe("auto");
    expect(s.theme).toBe("dark");
    expect(s.maxTurns).toBe(30);
  });

  it("returns empty when missing", () => {
    const s = loadJsoncSettings(join(tmpdir(), "definitely-does-not-exist-" + Date.now() + ".json"));
    expect(s).toEqual({});
  });
});
