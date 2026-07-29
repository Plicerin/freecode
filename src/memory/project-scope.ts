// A STABLE identity for "the project this session is in". Cross-session WORK
// memory is scoped to this key so one project's accumulated state can never be
// injected into another project's session (the whole point of the assistant
// peer — see store.ts). Without it, freecode recalled a single global blob and
// opened every project believing it was mid-work on whichever project the
// deriver had built up most: the "why does it think it's a different project?"
// bug. The USER peer stays global (genuine identity/preferences travel).

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** A git command runner (injectable for tests). Trimmed stdout, or null on ANY
 *  failure — not a repo, git not on PATH, etc. */
export type GitRunner = (args: string[], cwd: string) => string | null;

const defaultGit: GitRunner = (args, cwd) => {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || null;
  } catch {
    return null;
  }
};

/** The project key for `cwd`. Preference, most-shared → most-specific:
 *  1. the git `origin` remote  → the same repo shares memory across clones/machines
 *  2. the git worktree root    → a repo with no remote
 *  3. the cwd                  → not a repo at all
 *  Prefixed so a repo and a like-named folder can't collide. */
export function resolveProjectKey(cwd: string, git: GitRunner = defaultGit): string {
  const remote = git(["remote", "get-url", "origin"], cwd);
  if (remote) return `remote:${normalizeRemote(remote)}`;
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  return `path:${canonicalPath(top || cwd)}`;
}

/** Collapse the ssh/https/scp spellings of one repo onto a single key, so
 *  `git@github.com:Foo/Bar.git` and `https://github.com/Foo/Bar` are the SAME
 *  project (memory follows the repo, not the URL form you cloned with). */
export function normalizeRemote(url: string): string {
  let s = url.trim().toLowerCase().replace(/\.git$/, "");
  s = s.replace(/^git@([^:/]+):/, "$1/"); // scp-style ssh: git@host:owner/repo
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme://
  s = s.replace(/^[^@/]+@/, ""); // strip a leading user@ (ssh:// form)
  s = s.replace(/\/+$/, "");
  return s;
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
