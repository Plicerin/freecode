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
import { join } from "node:path";

declare const __FREECODE_VERSION__: string | undefined;

/** The freecode repo's current HEAD short SHA, read straight from .git relative
 *  to THIS file — so it works even when freecode runs with the user's project as
 *  cwd, and without needing git on PATH. null when there's no .git (e.g. a
 *  compiled binary, where the baked version is used). */
export function devGitSha(): string | null {
  try {
    const gitDir = join(import.meta.dir, "..", ".git");
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

export const VERSION: string =
  typeof __FREECODE_VERSION__ !== "undefined" && __FREECODE_VERSION__
    ? __FREECODE_VERSION__
    : (() => {
        const sha = devGitSha();
        return sha ? `0.1.0-dev+${sha}` : "0.1.0-dev";
      })();
