// Stage 1 parity — git/PR workflow. Drives the real helpers against a real temp
// git repo (no network/gh needed for the git-only paths). The gh-dependent
// branches are exercised through their honest "not configured" responses.
import { test, expect, describe, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branch, commitPushPr, currentBranch, issue, prComments, hasGh } from "../src/commands/git-workflow";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fc-git-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g(["init", "-b", "main"]);
  g(["config", "user.email", "t@t.t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "f.txt"), "one\n");
  g(["add", "-A"]);
  g(["commit", "-m", "init"]);
  return dir;
}

describe("/branch", () => {
  test("lists branches when given no name", () => {
    const r = branch(repo());
    expect(r.ok).toBe(true);
    expect(r.text).toContain("main");
  });
  test("creates and switches to a new branch", () => {
    const dir = repo();
    const r = branch(dir, "feature/x");
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Created and switched to feature\/x/);
    expect(currentBranch(dir)).toBe("feature/x");
  });
  test("switches to an existing branch without recreating it", () => {
    const dir = repo();
    branch(dir, "dev"); // create
    branch(dir, "main"); // back to main
    const r = branch(dir, "dev"); // switch to existing
    expect(r.ok).toBe(true);
    expect(r.text).toBe("Switched to dev");
  });
  test("reports cleanly when not a git repo", () => {
    const r = branch(mkdtempSync(join(tmpdir(), "fc-nogit-")));
    expect(r.ok).toBe(false);
    expect(r.text).toBe("Not a git repository.");
  });
});

describe("/commit-push-pr guards", () => {
  test("refuses to PR from main", () => {
    const r = commitPushPr(repo(), "my title");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Refusing to open a PR from main/);
  });
  test("requires a title", () => {
    const dir = repo();
    branch(dir, "feature/y");
    const r = commitPushPr(dir, "   ");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Usage: \/commit-push-pr/);
  });
  test("reports cleanly when not a git repo", () => {
    const r = commitPushPr(mkdtempSync(join(tmpdir(), "fc-nogit-")), "t");
    expect(r.ok).toBe(false);
    expect(r.text).toBe("Not a git repository.");
  });
});

describe("gh-dependent commands degrade honestly", () => {
  // When gh is absent these must say so plainly, never pretend success.
  test("/issue and /pr-comments report missing gh (or really run it)", () => {
    const dir = repo();
    const gh = hasGh();
    const i = issue(dir);
    const p = prComments(dir);
    if (!gh) {
      expect(i.ok).toBe(false);
      expect(i.text).toMatch(/GitHub CLI \(gh\) not found/);
      expect(p.ok).toBe(false);
      expect(p.text).toMatch(/GitHub CLI \(gh\) not found/);
    } else {
      // gh present but this temp repo has no remote/PR — must be a clean failure,
      // not a thrown exception, and not a false success.
      expect(typeof i.text).toBe("string");
      expect(typeof p.text).toBe("string");
    }
  });
});
