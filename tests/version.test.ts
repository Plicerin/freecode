// The startup version must reflect the ACTUAL running commit, so "did my restart
// load the fix?" is answerable at a glance instead of an act of faith. In dev
// (bun run) it reads the git HEAD short SHA from .git.
import { test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { devGitSha, VERSION } from "../src/version";

test("devGitSha returns a 7-hex short SHA read from .git", () => {
  const sha = devGitSha();
  expect(sha).toMatch(/^[0-9a-f]{7}$/);
});

test("it matches git's own HEAD (so a stale checkout shows a different SHA)", () => {
  let head: string | null = null;
  try {
    head = execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim();
  } catch {
    return; // no git binary here — the format test above already covers the parser
  }
  expect(devGitSha()).toBe(head);
});

test("VERSION carries the SHA in dev mode (bun run), not a frozen 'v0.1.0'", () => {
  // Either the baked build version (0.1.0+sha) or the dev fallback (0.1.0-dev+sha),
  // but never a hardcoded constant with no commit info.
  expect(VERSION).toMatch(/^0\.1\.0(-dev)?\+[0-9a-f]{7}/);
});
