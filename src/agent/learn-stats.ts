// Self-improvement, phase 2 — the measurement loop. This is the line between
// "freecode remembers things" and "freecode improves": every learned artifact
// carries a scorecard, and the ones that never earn their keep get pruned.
//
// What's HONESTLY measurable here:
//   • fires (skills)      — hard fact: the Skill tool loaded it. 0 fires after a
//                           while ⇒ dead weight ⇒ a decay candidate.
//   • verify-first-try    — from the activity log: did a session's first check
//     trend                pass? Compared before vs. after you started teaching
//                           freecode. Labelled CORRELATIONAL in the UI — we don't
//                           claim a single rule caused it.
// We deliberately do NOT fabricate a precise "saved you N corrections" causal
// number we can't substantiate — that would be the exact overclaim the verify
// gate exists to prevent.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeSkillName } from "./self-improve";

export interface LearnStat {
  id: string; // `${kind}:${safeName}`
  kind: "rule" | "skill";
  name: string;
  createdAt: string;
  fires: number;
  lastFiredAt?: string;
}

export function idFor(kind: LearnStat["kind"], name: string): string {
  return `${kind}:${safeSkillName(name)}`;
}

function statsFile(cwd: string): string {
  return join(cwd, ".freecode", "learn-stats.json");
}

export function loadStats(cwd: string): Record<string, LearnStat> {
  const f = statsFile(cwd);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Record<string, LearnStat>;
  } catch {
    return {};
  }
}

function saveStats(cwd: string, map: Record<string, LearnStat>): void {
  mkdirSync(join(cwd, ".freecode"), { recursive: true });
  writeFileSync(statsFile(cwd), JSON.stringify(map, null, 2));
}

/** Register an artifact's scorecard when it's first saved (fires start at 0). */
export function ensureStat(cwd: string, kind: LearnStat["kind"], name: string, createdAt: string): void {
  const map = loadStats(cwd);
  const id = idFor(kind, name);
  if (!map[id]) {
    map[id] = { id, kind, name, createdAt, fires: 0 };
    saveStats(cwd, map);
  }
}

/** Record that an artifact was used. Lazily creates a stat (e.g. a hand-made
 *  skill that fires gets a scorecard too). Never throws into the caller. */
export function recordFire(cwd: string, kind: LearnStat["kind"], name: string, at: string): void {
  try {
    const map = loadStats(cwd);
    const id = idFor(kind, name);
    const cur = map[id] ?? { id, kind, name, createdAt: at, fires: 0 };
    cur.fires += 1;
    cur.lastFiredAt = at;
    map[id] = cur;
    saveStats(cwd, map);
  } catch {
    /* measurement must never break a tool run */
  }
}

export function listStats(cwd: string): LearnStat[] {
  return Object.values(loadStats(cwd)).sort((a, b) => b.fires - a.fires || (a.createdAt < b.createdAt ? 1 : -1));
}

export function removeStat(cwd: string, id: string): void {
  const map = loadStats(cwd);
  if (map[id]) {
    delete map[id];
    saveStats(cwd, map);
  }
}

const DAY_MS = 86_400_000;

/** Learned artifacts that have never fired and are old enough to judge — the
 *  ones worth pruning. `asOf` is injectable so the rule is deterministic in tests. */
export function decayCandidates(
  stats: LearnStat[],
  opts: { asOf: number; minAgeDays?: number; minFires?: number },
): LearnStat[] {
  const minAge = (opts.minAgeDays ?? 7) * DAY_MS;
  const minFires = opts.minFires ?? 1;
  return stats.filter((s) => s.fires < minFires && opts.asOf - Date.parse(s.createdAt) >= minAge);
}

export interface VerifyTrend {
  before: { sessions: number; passedFirst: number };
  after: { sessions: number; passedFirst: number };
}

/** Parse the activity log into a before/after verify-first-try signal, split at
 *  the first `LEARN saved` marker (when the user started teaching freecode). Pure
 *  — operates on the log text, so it's testable without touching the real log. */
export function verifyTrend(logText: string): VerifyTrend {
  const before = { sessions: 0, passedFirst: 0 };
  const after = { sessions: 0, passedFirst: 0 };
  let taught = false;
  let inSession = false;
  let firstCheckSeen = false;

  for (const line of logText.split("\n")) {
    if (/\bLEARN saved\b/.test(line)) taught = true;
    if (/\bSESSION start\b/.test(line)) {
      inSession = true;
      firstCheckSeen = false;
      (taught ? after : before).sessions += 1;
      continue;
    }
    if (!inSession || firstCheckSeen) continue;
    const m = /\bCHECK\b.*→\s*(PASS|FAIL)/.exec(line);
    if (m) {
      firstCheckSeen = true;
      if (m[1] === "PASS") (taught ? after : before).passedFirst += 1;
    }
  }
  return { before, after };
}

/** Delete a learned SKILL's file + scorecard. Rules live as a FREECODE.md line
 *  the user edits by hand, so we only drop the stat for those. */
export function pruneArtifact(cwd: string, stat: LearnStat): { removedFile: boolean } {
  let removedFile = false;
  if (stat.kind === "skill") {
    const file = join(cwd, ".freecode", "skills", `${safeSkillName(stat.name)}.md`);
    if (existsSync(file)) {
      rmSync(file);
      removedFile = true;
    }
  }
  removeStat(cwd, stat.id);
  return { removedFile };
}
