import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnArgs } from "../tools/bash";

export interface VerifyPlan {
  commands: string[];
  source: "config" | "detected" | "none";
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
