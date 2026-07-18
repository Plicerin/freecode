import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, relative, resolve, isAbsolute } from "node:path";
import os from "node:os";
import { spawnArgs } from "../tools/bash";

export interface VerifyPlan {
  commands: string[];
  source: "config" | "detected" | "none";
}

/** True when cwd IS the user's home directory. A package.json / Cargo.toml there
 *  is almost always a stray or global one, not the edited artifact's project, so
 *  auto-detecting a verify command from it runs an UNRELATED build and then
 *  mislabels its pass as verification — e.g. `~/package.json` (an old Astro
 *  project) makes `bun run build` "verify" an edit to `~/Documents/game.html`
 *  that the build never imports. Auto-detection is refused here; an explicit
 *  `verify` config still applies (the user opted in). */
export function isHomeDir(cwd: string): boolean {
  try {
    const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
    return norm(cwd) === norm(os.homedir());
  } catch {
    return false;
  }
}

// Extensions a build / typecheck / test actually compiles or loads. A change
// confined to files OUTSIDE this set (a self-contained .html game, a loose
// .css, a .md, an image) is not exercised by such a check, so crediting its
// pass as verification of that change is a lie.
const COMPILED_SOURCE_EXT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".astro",
  ".rs", ".go", ".py", ".rb", ".java", ".kt", ".kts", ".scala", ".clj",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".cs", ".php", ".swift", ".ex", ".exs",
]);

function underRoot(root: string, file: string): boolean {
  const rel = relative(resolve(root), resolve(file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Does the verify command actually exercise the change? True only when at least
 *  one changed file is a compiled/loaded source type UNDER the command's root.
 *  A change of only standalone assets (a self-contained .html, a loose .css/.md/
 *  image) is not compiled by a build/typecheck/test — a passing check says
 *  nothing about it, so the caller must record it UNVERIFIED, not verified.
 *  Empty change set → true (nothing to gate; don't block a no-op). */
export function verifyCoversChanges(changedPaths: string[], cwd: string): boolean {
  if (!changedPaths.length) return true;
  return changedPaths.some((p) => underRoot(cwd, p) && COMPILED_SOURCE_EXT.has(extname(p).toLowerCase()));
}

export interface VerifyResult {
  ok: boolean;
  ranCommands: string[];
  failedCommand?: string;
  output: string;
}

function detectPackageManager(cwd: string): string {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Resolve the project's verification commands: an explicit `verify` config
 * wins; otherwise auto-detect from the project; otherwise none (honest skip).
 */
export function resolveVerify(cwd: string, configVerify?: string | string[]): VerifyPlan {
  if (configVerify) {
    const commands = (Array.isArray(configVerify) ? configVerify : [configVerify]).filter((c) => c.trim());
    if (commands.length) return { commands, source: "config" };
  }

  // Never auto-source a check from the home directory — a project marker there
  // is a stray/global one, and running its build would falsely "verify" an
  // unrelated edit. (Config above already returned; the user's explicit opt-in wins.)
  if (isHomeDir(cwd)) return { commands: [], source: "none" };

  // package.json — prefer the verification-y scripts that exist.
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<string, string>;
      const pm = detectPackageManager(cwd);
      const picked = ["typecheck", "test"].filter((s) => scripts[s]);
      if (picked.length === 0 && scripts.build) picked.push("build");
      if (picked.length) return { commands: picked.map((s) => `${pm} run ${s}`), source: "detected" };
    } catch { /* fall through */ }
  }

  if (existsSync(join(cwd, "Cargo.toml"))) return { commands: ["cargo test"], source: "detected" };
  if (existsSync(join(cwd, "go.mod"))) return { commands: ["go test ./..."], source: "detected" };
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "pytest.ini"))) return { commands: ["pytest -q"], source: "detected" };
  if (existsSync(join(cwd, "Makefile"))) {
    try {
      if (/^test:/m.test(readFileSync(join(cwd, "Makefile"), "utf8"))) return { commands: ["make test"], source: "detected" };
    } catch { /* ignore */ }
  }

  return { commands: [], source: "none" };
}

/**
 * Resolve a FAST check for the auto-gate — compile-level only (typecheck /
 * build / lint), never the full test suite, so it stays snappy. An explicit
 * verifyQuick config wins; otherwise auto-detect; otherwise none.
 */
export function resolveQuickVerify(cwd: string, configQuick?: string | string[]): VerifyPlan {
  if (configQuick) {
    const commands = (Array.isArray(configQuick) ? configQuick : [configQuick]).filter((c) => c.trim());
    if (commands.length) return { commands, source: "config" };
  }
  if (isHomeDir(cwd)) return { commands: [], source: "none" };  // stray ~/package.json is not this artifact's project
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<string, string>;
      const pm = detectPackageManager(cwd);
      const script = ["typecheck", "build", "lint"].find((s) => scripts[s]);
      if (script) return { commands: [`${pm} run ${script}`], source: "detected" };
    } catch { /* fall through */ }
  }
  if (existsSync(join(cwd, "Cargo.toml"))) return { commands: ["cargo check"], source: "detected" };
  if (existsSync(join(cwd, "go.mod"))) return { commands: ["go build ./..."], source: "detected" };
  return { commands: [], source: "none" };
}

function runOne(command: string, cwd: string, signal?: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const inv = spawnArgs(command);
      child = spawn(inv.file, inv.args, { shell: inv.useShell, cwd, signal });
    } catch (e) {
      return resolve({ code: 1, output: String(e) });
    }
    let output = "";
    const cap = 200_000;
    const onData = (b: Buffer) => { if (output.length < cap) output += b.toString("utf8"); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => resolve({ code: 1, output: output + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, output }));
  });
}

/** Run the plan's commands in order, stopping at the first failure. */
export async function runVerify(plan: VerifyPlan, cwd: string, signal?: AbortSignal): Promise<VerifyResult> {
  const ran: string[] = [];
  for (const command of plan.commands) {
    ran.push(command);
    const { code, output } = await runOne(command, cwd, signal);
    if (code !== 0) {
      return { ok: false, ranCommands: ran, failedCommand: command, output };
    }
  }
  return { ok: true, ranCommands: ran, output: "" };
}
