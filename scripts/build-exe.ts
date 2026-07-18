// Build a standalone `freecode` executable with a real, traceable version baked
// in. Version = package.json version + git short SHA (+ ".dirty" if the working
// tree has uncommitted changes), injected via Bun's --define so
// `freecode --version` reports exactly what was built. Run: bun run build:exe
//
// NOTE: Bun 1.3.x only honours the SPACE form of define (`--define K=V`); the
// `--define:K=V` colon form is silently ignored (verified empirically).
import { spawnSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const sha = git("rev-parse --short HEAD") || "nogit";
const dirty = git("status --porcelain") ? ".dirty" : "";
const version = `${pkg.version}+${sha}${dirty}`;

const out = process.platform === "win32" ? "dist/freecode.exe" : "dist/freecode";

console.log(`Building ${out}  (version ${version}) …`);
const r = spawnSync(
  "bun",
  [
    "build",
    "--compile",
    "src/cli.tsx",
    "--define",
    `__FREECODE_VERSION__=${JSON.stringify(version)}`,
    "--outfile",
    out,
  ],
  { stdio: "inherit" },
);

if (r.status === 0) console.log(`\nDone → ${out}  (run \`${out} --version\` → ${version})`);
process.exit(r.status ?? 1);
