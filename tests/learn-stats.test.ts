// Self-improvement phase 2 — the measurement loop. Scorecards make the
// difference between "freecode remembers" and "freecode improves": fires are a
// hard fact, never-fired-and-old artifacts decay, and the verify-first-try trend
// is parsed from the activity log (labelled correlational in the UI). All pure +
// temp-dir, so nothing touches the real project or log.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureStat, recordFire, listStats, removeStat, decayCandidates, verifyTrend, pruneArtifact, idFor,
  type LearnStat,
} from "../src/agent/learn-stats";

describe("scorecard store", () => {
  test("ensureStat creates a stat at 0 fires and is idempotent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fc-ls-"));
    ensureStat(cwd, "skill", "release-flow", "2026-06-01T00:00:00.000Z");
    recordFire(cwd, "skill", "release-flow", "2026-06-02T00:00:00.000Z");
    ensureStat(cwd, "skill", "release-flow", "2026-06-03T00:00:00.000Z"); // must NOT reset fires
    const s = listStats(cwd).find((x) => x.name === "release-flow")!;
    expect(s.fires).toBe(1);
    expect(s.createdAt).toBe("2026-06-01T00:00:00.000Z");
  });

  test("recordFire increments and lazily creates for an unknown skill", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fc-ls-"));
    recordFire(cwd, "skill", "adhoc", "2026-06-02T00:00:00.000Z");
    recordFire(cwd, "skill", "adhoc", "2026-06-02T01:00:00.000Z");
    const s = listStats(cwd)[0]!;
    expect(s.fires).toBe(2);
    expect(s.lastFiredAt).toBe("2026-06-02T01:00:00.000Z");
  });

  test("listStats sorts by fires desc; removeStat deletes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fc-ls-"));
    ensureStat(cwd, "rule", "a", "2026-06-01T00:00:00.000Z");
    recordFire(cwd, "skill", "b", "2026-06-01T00:00:00.000Z");
    expect(listStats(cwd).map((s) => s.name)).toEqual(["b", "a"]);
    removeStat(cwd, idFor("skill", "b"));
    expect(listStats(cwd).map((s) => s.name)).toEqual(["a"]);
  });
});

describe("decay", () => {
  const stat = (over: Partial<LearnStat>): LearnStat => ({
    id: "x", kind: "skill", name: "n", createdAt: "2026-06-01T00:00:00.000Z", fires: 0, ...over,
  });
  const asOf = Date.parse("2026-06-15T00:00:00.000Z"); // 14 days after createdAt

  test("a never-fired, old-enough artifact is a decay candidate", () => {
    const out = decayCandidates([stat({ name: "dead" })], { asOf, minAgeDays: 7 });
    expect(out.map((s) => s.name)).toEqual(["dead"]);
  });

  test("a fired artifact is never a candidate, and a too-new one isn't either", () => {
    const fresh = stat({ name: "fresh", createdAt: "2026-06-14T00:00:00.000Z" }); // 1 day old
    const used = stat({ name: "used", fires: 3 });
    expect(decayCandidates([fresh, used], { asOf, minAgeDays: 7 })).toEqual([]);
  });
});

describe("verifyTrend (activity-log parsing)", () => {
  test("splits verify-first-try before vs after the first 'LEARN saved' marker", () => {
    const log = [
      "t SESSION start cwd=/x",
      "t CHECK bun test → PASS",   // before: pass
      "t SESSION start cwd=/x",
      "t CHECK bun test → FAIL",   // before: fail (only the FIRST check per session counts)
      "t CHECK bun test → PASS",   // ignored (not first)
      "t LEARN saved rule \"run-tests-first\"",
      "t SESSION start cwd=/x",
      "t CHECK bun test → PASS",   // after: pass
      "t SESSION start cwd=/x",
      "t CHECK bun test → PASS",   // after: pass
    ].join("\n");
    const tr = verifyTrend(log);
    expect(tr.before).toEqual({ sessions: 2, passedFirst: 1 });
    expect(tr.after).toEqual({ sessions: 2, passedFirst: 2 });
  });

  test("empty log yields zeroes", () => {
    expect(verifyTrend("")).toEqual({ before: { sessions: 0, passedFirst: 0 }, after: { sessions: 0, passedFirst: 0 } });
  });
});

describe("prune", () => {
  test("pruning a skill removes its file and scorecard", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fc-ls-"));
    mkdirSync(join(cwd, ".freecode", "skills"), { recursive: true });
    writeFileSync(join(cwd, ".freecode", "skills", "dead.md"), "---\ndescription: x\n---\nbody");
    ensureStat(cwd, "skill", "dead", "2026-06-01T00:00:00.000Z");
    const r = pruneArtifact(cwd, listStats(cwd)[0]!);
    expect(r.removedFile).toBe(true);
    expect(existsSync(join(cwd, ".freecode", "skills", "dead.md"))).toBe(false);
    expect(listStats(cwd)).toEqual([]);
  });

  test("pruning a rule drops the scorecard only (no file to delete)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fc-ls-"));
    ensureStat(cwd, "rule", "r", "2026-06-01T00:00:00.000Z");
    const r = pruneArtifact(cwd, listStats(cwd)[0]!);
    expect(r.removedFile).toBe(false);
    expect(listStats(cwd)).toEqual([]);
  });
});
