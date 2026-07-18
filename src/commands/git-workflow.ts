// Stage 1 of OpenClaude parity: the git/PR workflow commands. Thin, honest
// shells over `git` and the GitHub CLI (`gh`) — no pretending an action
// happened when the tool is missing or the call failed. Kept out of the REPL so
// the logic is unit-testable against a real temp repo.
import { execFileSync } from "node:child_process";

export interface CmdResult {
  ok: boolean;
  text: string;
}

/** Run a binary, capturing output, WITHOUT throwing on a non-zero exit — we
 *  surface failures as data so the caller can report them faithfully. */
function run(file: string, args: string[], cwd: string, input?: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(file, args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown; message?: string };
    const out = `${err.stdout ? String(err.stdout) : ""}${err.stderr ? String(err.stderr) : ""}`.trim();
    return { ok: false, out: out || err.message || "command failed" };
  }
}

/** Is the GitHub CLI installed? gh-dependent commands check this and say so
 *  plainly rather than failing cryptically. */
export function hasGh(): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(finder, ["gh"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function currentBranch(cwd: string): string | null {
  const r = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return r.ok ? r.out : null;
}

/** /branch — no name: list branches (most-recent first). With a name: switch to
 *  it, creating it if it doesn't exist. */
export function branch(cwd: string, name?: string): CmdResult {
  if (!currentBranch(cwd)) return { ok: false, text: "Not a git repository." };
  if (!name) {
    const r = run("git", ["branch", "--sort=-committerdate"], cwd);
    return { ok: r.ok, text: r.ok ? r.out : `git branch failed: ${r.out}` };
  }
  const exists = run("git", ["rev-parse", "--verify", "--quiet", name], cwd).ok;
  const r = exists ? run("git", ["switch", name], cwd) : run("git", ["switch", "-c", name], cwd);
  if (!r.ok) return { ok: false, text: `branch switch failed: ${r.out}` };
  return { ok: true, text: exists ? `Switched to ${name}` : `Created and switched to ${name}` };
}

/** /commit-push-pr — commit any pending changes, push the branch, open a PR.
 *  Refuses to run from main/master (you PR *from* a feature branch). */
export function commitPushPr(cwd: string, title: string): CmdResult {
  const br = currentBranch(cwd);
  if (!br) return { ok: false, text: "Not a git repository." };
  if (br === "main" || br === "master") {
    return { ok: false, text: `Refusing to open a PR from ${br}. Create a feature branch first: /branch <name>` };
  }
  if (!title.trim()) return { ok: false, text: "Usage: /commit-push-pr <title>" };

  const dirty = run("git", ["status", "--short"], cwd).out;
  if (dirty) {
    run("git", ["add", "-A"], cwd);
    const c = run("git", ["commit", "-F", "-"], cwd, title);
    if (!c.ok) return { ok: false, text: `commit failed: ${c.out}` };
  }
  const push = run("git", ["push", "-u", "origin", "HEAD"], cwd);
  if (!push.ok) return { ok: false, text: `push failed: ${push.out}` };
  if (!hasGh()) {
    return { ok: true, text: `Pushed ${br}. Install the GitHub CLI (gh) to open the PR automatically, or open it on GitHub.` };
  }
  const pr = run("gh", ["pr", "create", "--title", title, "--body", ""], cwd);
  return { ok: pr.ok, text: pr.ok ? `✓ ${pr.out}` : `pr create failed: ${pr.out}` };
}

/** /issue — no title: list open issues. With a title: open a new one. */
export function issue(cwd: string, title?: string): CmdResult {
  if (!hasGh()) return { ok: false, text: "GitHub CLI (gh) not found — needed for /issue." };
  if (!title?.trim()) {
    const r = run("gh", ["issue", "list", "--limit", "20"], cwd);
    return { ok: r.ok, text: r.ok ? r.out || "No open issues." : `gh issue list failed: ${r.out}` };
  }
  const r = run("gh", ["issue", "create", "--title", title, "--body", ""], cwd);
  return { ok: r.ok, text: r.ok ? `✓ Issue created: ${r.out}` : `gh issue create failed: ${r.out}` };
}

/** /pr-comments — show review comments on the current branch's PR. */
export function prComments(cwd: string): CmdResult {
  if (!hasGh()) return { ok: false, text: "GitHub CLI (gh) not found — needed for /pr-comments." };
  const r = run("gh", ["pr", "view", "--comments"], cwd);
  return { ok: r.ok, text: r.ok ? r.out : `gh pr view failed: ${r.out}` };
}
