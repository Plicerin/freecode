// Project scoping for cross-session memory: the key that decides which sessions
// share work memory. Locks the preference order (remote → worktree → cwd) and
// that ssh/https/scp spellings of one repo collapse to a single key.
import { test, expect, describe } from "bun:test";
import { resolveProjectKey, normalizeRemote, type GitRunner } from "../src/memory/project-scope";

/** A fake git that answers only what the test sets. */
const git = (map: { remote?: string | null; toplevel?: string | null }): GitRunner => (args) => {
  if (args[0] === "remote") return map.remote ?? null;
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return map.toplevel ?? null;
  return null;
};

describe("resolveProjectKey", () => {
  test("prefers the origin remote (so a repo is one project across clones/machines)", () => {
    expect(resolveProjectKey("/anywhere", git({ remote: "git@github.com:Plicerin/freecode.git" })))
      .toBe("remote:github.com/plicerin/freecode");
  });
  test("falls back to the git worktree root when there is no remote", () => {
    expect(resolveProjectKey("/repo/sub/dir", git({ remote: null, toplevel: "/repo" }))).toBe("path:/repo");
  });
  test("falls back to the cwd when it isn't a repo at all", () => {
    expect(resolveProjectKey("/scratch/dir", git({}))).toBe("path:/scratch/dir");
  });
  test("distinct repos → distinct keys; the same repo → the same key", () => {
    const a = resolveProjectKey("/a", git({ remote: "https://github.com/o/alpha" }));
    const b = resolveProjectKey("/b", git({ remote: "https://github.com/o/beta" }));
    expect(a).not.toBe(b);
    expect(resolveProjectKey("/elsewhere", git({ remote: "https://github.com/o/alpha" }))).toBe(a);
  });
});

describe("normalizeRemote", () => {
  test("scp, https, and ssh spellings of one repo collapse together", () => {
    const want = "github.com/plicerin/freecode";
    expect(normalizeRemote("git@github.com:Plicerin/freecode.git")).toBe(want);
    expect(normalizeRemote("https://github.com/Plicerin/freecode.git")).toBe(want);
    expect(normalizeRemote("https://github.com/Plicerin/freecode")).toBe(want);
    expect(normalizeRemote("ssh://git@github.com/Plicerin/freecode.git")).toBe(want);
    expect(normalizeRemote("https://github.com/Plicerin/freecode/")).toBe(want);
  });
});
