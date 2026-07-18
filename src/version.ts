// Single source of the version string shown by `freecode --version` and at
// startup.
//
// For a COMPILED build, scripts/build-exe.ts injects the real version
// (package.json version + git short SHA, e.g. "0.1.0+a1b2c3d") via Bun's
// `--define:__FREECODE_VERSION__=...`.
//
// When running from source (`bun run src/cli.tsx`) the define is absent, so we
// read the git HEAD short SHA at runtime and show "0.1.0-dev+<sha>". This is what
// lets you CONFIRM which code a restart actually loaded — a stale checkout shows
// a different SHA, so "did the fix apply?" is answerable, not an act of faith.
// `typeof` on an undeclared identifier is safe (never throws), so this works in
// both modes without a try/catch.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

declare const __FREECODE_VERSION__: string | undefined;

/** This module's directory, portably: Bun exposes import.meta.dir; Node derives
 *  it from import.meta.url. Lets the git-sha read work under both runtimes. */
function moduleDir(): string {
  const meta = import.meta as { dir?: string; url?: string };
  if (meta.dir) return meta.dir; // Bun
  if (meta.url) return dirname(fileURLToPath(meta.url)); // Node
  return process.cwd();
}

/** The freecode repo's current HEAD short SHA, read straight from .git relative
 *  to THIS file — so it works even when freecode runs with the user's project as
 *  cwd, and without needing git on PATH. null when there's no .git (e.g. a
 *  compiled binary, where the baked version is used). */
export function devGitSha(): string | null {
  try {
    const gitDir = join(moduleDir(), "..", ".git");
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*(.+)$/);
    let sha: string;
    if (!ref) {
      sha = head; // detached HEAD is the raw sha
    } else {
      try {
        sha = readFileSync(join(gitDir, ref[1]!), "utf8").trim();
      } catch {
        // packed-refs fallback (a freshly-cloned ref may not have a loose file)
        const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
        const line = packed.split("\n").find((l) => l.endsWith(" " + ref[1]!));
        if (!line) return null;
        sha = line.split(" ")[0]!;
      }
    }
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
    return sha.slice(0, 7);
  } catch {
    return null;
  }
}

/** The base version from package.json (next to this file's dir), so the dev-mode
 *  string never drifts from the real version the way a hardcoded literal did. */
function pkgVersion(): string {
  try {
    const raw = readFileSync(join(moduleDir(), "..", "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string =
  typeof __FREECODE_VERSION__ !== "undefined" && __FREECODE_VERSION__
    ? __FREECODE_VERSION__
    : (() => {
        const sha = devGitSha();
        const base = pkgVersion();
        return sha ? `${base}-dev+${sha}` : `${base}-dev`;
      })();
