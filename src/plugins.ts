// Plugins (ROADMAP Tier A). A plugin is just a bundle of the things freecode
// already loads: a directory with a `plugin.json` manifest and any of the
// familiar `commands/`, `agents/`, `skills/`, `workflows/` subdirs. The existing
// resolvers each scan an enabled plugin's matching subdir (between the user and
// project locations), so plugins contribute through the same code paths — no new
// formats. The marketplace/install half (network, versioning) is deferred; this
// is local discovery + enable/disable.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, cpSync, rmSync, renameSync, mkdtempSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, isAbsolute } from "node:path";
import { APP_DIR } from "./utils/paths";

const execFileAsync = promisify(execFile);

export type PluginKind = "commands" | "agents" | "skills" | "workflows";
export const PLUGIN_KINDS: PluginKind[] = ["commands", "agents", "skills", "workflows"];

export interface Plugin {
  name: string;
  description: string;
  version?: string;
  dir: string;
  source: "user" | "project";
  enabled: boolean;
}

// Disabled plugins are persisted by name (enabled is the default for anything
// discovered), so a plugin dropped into the folder works without ceremony.
const STATE_FILE = join(APP_DIR, "plugins-state.json");

function loadDisabled(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { disabled?: string[] };
    return new Set(parsed.disabled ?? []);
  } catch {
    return new Set();
  }
}

function saveDisabled(disabled: Set<string>): void {
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ disabled: [...disabled] }, null, 2));
}

/** Discover plugins from the user dir and the project's `.freecode/plugins`.
 *  A plugin needs a `plugin.json` (name optional — defaults to the folder). */
export function resolvePlugins(cwd: string): Plugin[] {
  const disabled = loadDisabled();
  const out = new Map<string, Plugin>();
  const bases: Array<[string, Plugin["source"]]> = [
    [join(APP_DIR, "plugins"), "user"],
    [join(cwd, ".freecode", "plugins"), "project"],
  ];
  for (const [base, source] of bases) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue; // skip staging/.git/hidden dirs
      const manifest = join(base, entry.name, "plugin.json");
      if (!existsSync(manifest)) continue;
      try {
        const m = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; description?: string; version?: string };
        const name = m.name?.trim() || entry.name;
        out.set(name, {
          name,
          description: m.description ?? "",
          version: m.version,
          dir: join(base, entry.name),
          source,
          enabled: !disabled.has(name),
        });
      } catch {
        // skip a plugin with an unreadable/invalid manifest
      }
    }
  }
  return [...out.values()];
}

export function setPluginEnabled(name: string, enabled: boolean): void {
  const disabled = loadDisabled();
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  saveDisabled(disabled);
}

/** The subdirs enabled plugins contribute for a given kind — fed to the existing
 *  resolvers so plugin commands/agents/skills/workflows load like local ones. */
export function pluginDirs(cwd: string, kind: PluginKind): string[] {
  return resolvePlugins(cwd)
    .filter((p) => p.enabled)
    .map((p) => join(p.dir, kind));
}

// ── Install / uninstall ────────────────────────────────────────────────────
// A plugin is fetched from a git URL (cloned) or copied from a local directory
// into the USER plugins dir, where it sits alongside hand-made ones. There is no
// central registry — you install from wherever the bundle lives. Cloning/copying
// only moves files (prompt templates, skill markdown, workflow JSON); nothing is
// executed at install time. The `root` param exists so tests can target a temp
// dir instead of the real ~/.freecode/plugins.

/** What a plugin ships, summarised by kind (names only) — shown after install. */
export type Contributions = Record<PluginKind, string[]>;

export interface InstalledPlugin extends Plugin {
  contributions: Contributions;
}

function userPluginsRoot(): string {
  return join(APP_DIR, "plugins");
}

/** A git source vs. a local path: URLs, scp-style git@…, or a trailing .git. */
function isGitSource(source: string): boolean {
  return /^https?:\/\//.test(source) || /^git@/.test(source) || /^ssh:\/\//.test(source) || source.endsWith(".git");
}

/** Fallback plugin name from a source when the manifest omits one. */
function deriveName(source: string): string {
  return source.replace(/\.git$/, "").replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
}

function readManifest(dir: string): { name?: string; description?: string; version?: string } | null {
  const manifest = join(dir, "plugin.json");
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; description?: string; version?: string };
  } catch {
    return null;
  }
}

/** Names a plugin contributes per kind (commands/agents/skills are .md, workflows .json). */
function summarizeContributions(dir: string): Contributions {
  const out = {} as Contributions;
  for (const kind of PLUGIN_KINDS) {
    const kdir = join(dir, kind);
    const ext = kind === "workflows" ? ".json" : ".md";
    out[kind] = existsSync(kdir)
      ? readdirSync(kdir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length))
      : [];
  }
  return out;
}

/** Install a plugin from a git URL or local directory into the user plugins dir.
 *  Stages into a hidden temp dir on the same volume, validates the manifest, then
 *  atomically moves it into place as `<root>/<plugin name>`. Refuses to clobber an
 *  already-installed plugin of the same name. */
export async function installPlugin(source: string, cwd: string, root: string = userPluginsRoot()): Promise<InstalledPlugin> {
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, ".staging-"));
  try {
    if (isGitSource(source)) {
      await execFileAsync("git", ["clone", "--depth", "1", source, staging], { timeout: 120_000 });
      rmSync(join(staging, ".git"), { recursive: true, force: true });
    } else {
      const abs = isAbsolute(source) ? source : join(cwd, source);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        throw new Error(`Local path is not a directory: ${abs}`);
      }
      cpSync(abs, staging, { recursive: true });
    }
    const manifest = readManifest(staging);
    if (!manifest) throw new Error("No valid plugin.json found in the plugin source.");
    const name = manifest.name?.trim() || deriveName(source);
    if (!name) throw new Error("Could not determine a plugin name (no manifest name and unnamable source).");
    const dest = join(root, name);
    if (existsSync(dest)) throw new Error(`Plugin "${name}" is already installed. Uninstall it first: /plugins uninstall ${name}`);
    renameSync(staging, dest);
    return {
      name,
      description: manifest.description ?? "",
      version: manifest.version,
      dir: dest,
      source: "user",
      enabled: true,
      contributions: summarizeContributions(dest),
    };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

/** Remove an installed user plugin and clear any stale disabled flag. Only the
 *  user plugins dir is touched — project plugins live in the repo and are managed
 *  there. */
export function uninstallPlugin(name: string, root: string = userPluginsRoot()): void {
  const dest = join(root, name);
  if (!existsSync(dest)) throw new Error(`Plugin "${name}" is not installed in the user plugins dir.`);
  rmSync(dest, { recursive: true, force: true });
  const disabled = loadDisabled();
  if (disabled.delete(name)) saveDisabled(disabled);
}
