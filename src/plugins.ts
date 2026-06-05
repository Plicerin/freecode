// Plugins (ROADMAP Tier A). A plugin is just a bundle of the things freecode
// already loads: a directory with a `plugin.json` manifest and any of the
// familiar `commands/`, `agents/`, `skills/`, `workflows/` subdirs. The existing
// resolvers each scan an enabled plugin's matching subdir (between the user and
// project locations), so plugins contribute through the same code paths — no new
// formats. The marketplace/install half (network, versioning) is deferred; this
// is local discovery + enable/disable.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./utils/paths";

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
