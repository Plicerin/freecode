// Orient the agent with FACTS, not exhortations. A 12B model can't reliably
// acquire the habit "check your directory before running build" — but it can act
// on "this folder has no package.json; the project is in ./WinPort-Monitor
// (vite+tauri; scripts: build, tauri:build)". This closes the class of failures
// where the agent operates blind:
//   - launched in a wrapper folder, so `npm run build` walks UP and runs a
//     stranger's package.json (observed: an Astro project in the home dir),
//   - then blames "the environment" when its invented commands fail.
// We hand the model the project root, package manager, and scripts it would
// otherwise guess. freecode does the looking; the model just acts on the result.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";

const PKG = "package.json";
// Non-Node markers that still say "a project lives here".
const OTHER_MARKERS = [".git", "Cargo.toml", "pyproject.toml", "go.mod", "deno.json", "deno.jsonc"];

export interface PackageFacts {
  dir: string;
  name?: string;
  scripts: string[];
  packageManager?: string; // npm | pnpm | yarn | bun (from the lockfile)
  tauri: boolean;          // src-tauri/ present → a Tauri desktop app
}

export interface EnvironmentInfo {
  cwd: string;
  here: PackageFacts | null;     // package.json AT cwd, if any
  ancestor: PackageFacts | null; // nearest package.json ABOVE cwd (what `npm run` climbs to) when cwd has none
  children: PackageFacts[];      // immediate child dirs that are themselves projects (the wrapper-folder trap)
  otherMarkersHere: string[];    // non-package markers at cwd (.git, Cargo.toml, …)
}

/** Which package manager a directory uses, read from its lockfile. */
export function detectPackageManager(dir: string): string | undefined {
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return undefined;
}

function readPackageFacts(dir: string): PackageFacts | null {
  const p = join(dir, PKG);
  let raw: string;
  try {
    if (!statSync(p).isFile()) return null;
    raw = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  let parsed: { name?: unknown; scripts?: unknown } = {};
  try {
    parsed = (JSON.parse(raw) as typeof parsed) ?? {};
  } catch {
    // Corrupt JSON — still record that a (broken) project lives here.
  }
  const scripts =
    parsed.scripts && typeof parsed.scripts === "object"
      ? Object.keys(parsed.scripts as Record<string, unknown>)
      : [];
  return {
    dir,
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    scripts,
    packageManager: detectPackageManager(dir),
    tauri: existsSync(join(dir, "src-tauri")),
  };
}

function nearestAncestorPackage(cwd: string): PackageFacts | null {
  let dir = dirname(cwd);
  for (;;) {
    const facts = readPackageFacts(dir);
    if (facts) return facts;
    const parent = dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
}

function childProjects(cwd: string, limit = 6): PackageFacts[] {
  let dirs: string[];
  try {
    dirs = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .slice(0, 40); // cap the scan; a wrapper folder has few children
  } catch {
    return [];
  }
  const out: PackageFacts[] = [];
  for (const name of dirs) {
    const facts = readPackageFacts(join(cwd, name));
    if (facts) out.push(facts);
    if (out.length >= limit) break;
  }
  return out;
}

/** Detect where the project actually is relative to cwd, plus how to drive it. */
export function detectEnvironment(cwd: string): EnvironmentInfo {
  const here = readPackageFacts(cwd);
  return {
    cwd,
    here,
    ancestor: here ? null : nearestAncestorPackage(cwd),
    children: here ? [] : childProjects(cwd),
    otherMarkersHere: OTHER_MARKERS.filter((m) => existsSync(join(cwd, m))),
  };
}

function describe(p: PackageFacts): string {
  return [
    p.name ?? "unnamed",
    p.packageManager,
    p.tauri ? "Tauri" : null,
    p.scripts.length ? `scripts: ${p.scripts.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The orientation block, as system-prompt lines. Facts only — no exhortation. */
export function environmentLines(env: EnvironmentInfo, platform: string, shell: string): string[] {
  const bun = (process.versions as { bun?: string }).bun;
  const out = [
    "Environment:",
    `- Operating system: ${platform}`,
    `- Shell (the Bash tool executes commands here): ${shell}`,
    `- Runtime on PATH: ${bun ? `bun ${bun}, ` : ""}node ${process.versions.node}`,
    `- Current working directory: ${env.cwd}`,
  ];

  if (env.here) {
    out.push(`- This directory IS the project root.`);
    out.push(`  - package.json: ${describe(env.here)}`);
  } else if (env.children.length) {
    // The wrapper-folder trap — the marquee case this feature exists to prevent.
    out.push(
      `- ⚠ There is NO package.json in this directory. The project lives in a SUBFOLDER — run project commands (install, build, the package manager) from there, not here:`,
    );
    for (const c of env.children) out.push(`  - ./${basename(c.dir)} — ${describe(c)}`);
    if (env.ancestor) {
      out.push(
        `  - Beware: with no package.json here, \`npm/pnpm/yarn run <script>\` walks UP and runs ${join(env.ancestor.dir, PKG)} (${env.ancestor.name ?? "unnamed"}) — an unrelated project, almost certainly not what you want.`,
      );
    }
  } else if (env.ancestor) {
    out.push(
      `- ⚠ No package.json in this directory. \`npm/pnpm/yarn run <script>\` here resolves ${join(env.ancestor.dir, PKG)} (${env.ancestor.name ?? "unnamed"}) by walking UP — confirm that's the project you mean before relying on it.`,
    );
  } else if (env.otherMarkersHere.length) {
    out.push(`- This directory is a project root (markers: ${env.otherMarkersHere.join(", ")}); no package.json.`);
  } else {
    out.push(`- No project markers (package.json/.git/Cargo.toml/…) found at or above this directory.`);
  }
  return out;
}
