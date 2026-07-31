// Plugins (ROADMAP Tier A): a plugin bundles commands/agents/skills/workflows
// behind a plugin.json, and the existing resolvers scan enabled plugins. Tests
// use temp project dirs and never touch the user's real plugin state.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePlugins, pluginDirs, installPlugin, uninstallPlugin } from "../src/plugins";
import { resolveSkills } from "../src/agent/skills";
import { existsSync } from "node:fs";

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

// A standalone plugin bundle to install FROM (separate from the install target).
function sourceBundle(opts: { name?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fc-src-"));
  const manifest: Record<string, unknown> = { description: "an installable plugin", version: "2.1.0" };
  if (opts.name) manifest.name = opts.name;
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "skills", "greet.md"), "---\ndescription: greet\n---\nGreet warmly.");
  mkdirSync(join(dir, "commands"), { recursive: true });
  writeFileSync(join(dir, "commands", "wave.md"), "Wave at the user.");
  return dir;
}

describe("install / uninstall (local path)", () => {
  test("rejects a manifest name that escapes the plugin root", async () => {
    const host = mkdtempSync(join(tmpdir(), "fc-plugin-traversal-"));
    const root = join(host, "plugins");
    mkdirSync(root);
    await expect(installPlugin(sourceBundle({ name: "../escaped" }), process.cwd(), root)).rejects.toThrow(/invalid plugin name/i);
    expect(existsSync(join(host, "escaped"))).toBe(false);
  });

  test("uninstall rejects traversal without deleting the target", () => {
    const host = mkdtempSync(join(tmpdir(), "fc-plugin-traversal-"));
    const root = join(host, "plugins");
    const outside = join(host, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    expect(() => uninstallPlugin("../outside", root)).toThrow(/invalid plugin name/i);
    expect(existsSync(outside)).toBe(true);
  });

  test("installs a local bundle into the target root with its contributions", async () => {
    const root = mkdtempSync(join(tmpdir(), "fc-root-"));
    const installed = await installPlugin(sourceBundle({ name: "greeter" }), process.cwd(), root);
    expect(installed.name).toBe("greeter");
    expect(installed.version).toBe("2.1.0");
    expect(installed.source).toBe("user");
    expect(installed.enabled).toBe(true);
    expect(installed.contributions.skills).toContain("greet");
    expect(installed.contributions.commands).toContain("wave");
    expect(existsSync(join(root, "greeter", "plugin.json"))).toBe(true);
  });

  test("derives the name from the source folder when the manifest omits one", async () => {
    const root = mkdtempSync(join(tmpdir(), "fc-root-"));
    const src = sourceBundle(); // no name in manifest
    const installed = await installPlugin(src, process.cwd(), root);
    expect(installed.name).toBe(src.split(/[/\\]/).pop()!);
  });

  test("refuses to clobber an already-installed plugin of the same name", async () => {
    const root = mkdtempSync(join(tmpdir(), "fc-root-"));
    await installPlugin(sourceBundle({ name: "dup" }), process.cwd(), root);
    await expect(installPlugin(sourceBundle({ name: "dup" }), process.cwd(), root)).rejects.toThrow(/already installed/);
  });

  test("rejects a source directory with no plugin.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "fc-root-"));
    const empty = mkdtempSync(join(tmpdir(), "fc-empty-"));
    await expect(installPlugin(empty, process.cwd(), root)).rejects.toThrow(/plugin\.json/);
    // a failed install leaves no staging dirs behind
    expect(existsSync(join(root, "greeter"))).toBe(false);
  });

  test("uninstall removes the installed plugin dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "fc-root-"));
    await installPlugin(sourceBundle({ name: "temp" }), process.cwd(), root);
    expect(existsSync(join(root, "temp"))).toBe(true);
    uninstallPlugin("temp", root);
    expect(existsSync(join(root, "temp"))).toBe(false);
  });

  test("uninstall throws when the plugin isn't installed", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-root-"));
    expect(() => uninstallPlugin("ghost", root)).toThrow(/not installed/);
  });
});
