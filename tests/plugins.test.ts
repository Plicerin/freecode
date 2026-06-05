// Plugins (ROADMAP Tier A): a plugin bundles commands/agents/skills/workflows
// behind a plugin.json, and the existing resolvers scan enabled plugins. Tests
// use temp project dirs and never touch the user's real plugin state.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePlugins, pluginDirs } from "../src/plugins";
import { resolveSkills } from "../src/agent/skills";

// A temp project containing a "demo" plugin that ships one skill.
function projectWithPlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), "fc-plugins-"));
  const p = join(dir, ".freecode", "plugins", "demo");
  mkdirSync(join(p, "skills"), { recursive: true });
  writeFileSync(join(p, "plugin.json"), JSON.stringify({ name: "demo", description: "a demo plugin", version: "1.0.0" }));
  writeFileSync(join(p, "skills", "hello.md"), "---\ndescription: say hello\n---\nSay hello to the user.");
  return dir;
}

describe("plugin discovery", () => {
  test("finds a project plugin from its manifest (enabled by default)", () => {
    const demo = resolvePlugins(projectWithPlugin()).find((p) => p.name === "demo");
    expect(demo).toBeDefined();
    expect(demo!.source).toBe("project");
    expect(demo!.version).toBe("1.0.0");
    expect(demo!.enabled).toBe(true);
  });

  test("skips a plugin folder with a missing or invalid manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-plugins-bad-"));
    mkdirSync(join(dir, ".freecode", "plugins", "broken"), { recursive: true });
    writeFileSync(join(dir, ".freecode", "plugins", "broken", "plugin.json"), "{ not json");
    mkdirSync(join(dir, ".freecode", "plugins", "nomanifest"), { recursive: true });
    const names = resolvePlugins(dir).map((p) => p.name);
    expect(names).not.toContain("broken");
    expect(names).not.toContain("nomanifest");
  });
});

describe("plugin contributions flow through the existing resolvers", () => {
  test("pluginDirs lists an enabled plugin's kind subdir", () => {
    const dirs = pluginDirs(projectWithPlugin(), "skills");
    expect(dirs.some((d) => d.endsWith(join("demo", "skills")))).toBe(true);
  });

  test("a plugin's skill is discovered by resolveSkills, tagged source=plugin", () => {
    const hello = resolveSkills(projectWithPlugin()).find((s) => s.name === "hello");
    expect(hello).toBeDefined();
    expect(hello!.source).toBe("plugin");
    expect(hello!.body).toContain("Say hello");
  });
});
