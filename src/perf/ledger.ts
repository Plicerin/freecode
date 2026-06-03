// The persistent performance ledger — freecode's record of its own best times.
// This is what lets it "race its own ghost": each run is compared against the
// stored personal best for THIS machine, and a change only counts as a win or a
// regression if it clears the noise band. No external repo, no imitation — the
// only opponent is its own past self.

import os from "node:os";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchStats } from "./bench";

const LEDGER_PATH = join(os.homedir(), ".freecode", "perf.json");

export interface EnvFingerprint {
  platform: string;
  arch: string;
  cpu: string;
  cpus: number;
  runtime: string;
}

// Perf numbers are meaningless across machines, so the ledger is keyed by an
// environment fingerprint. A faster laptop must not "beat the ghost" of a
// slower CI box — only like-for-like comparisons count.
export function envFingerprint(): EnvFingerprint {
  const cpus = os.cpus?.() ?? [];
  const bunVer = (globalThis as { Bun?: { version?: string } }).Bun?.version ?? "node";
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: (cpus[0]?.model ?? "unknown").trim(),
    cpus: cpus.length,
    runtime: `bun-${bunVer}`,
  };
}

export function envKey(e: EnvFingerprint): string {
  return `${e.platform}/${e.arch}/${e.cpus}x/${e.runtime}`;
}

export interface PersonalBest {
  median: number;
  min: number;
  mad: number;
  ts: string; // ISO timestamp when this best was set
  commit?: string; // git short hash, if available
}

export interface PerfLedger {
  version: 1;
  envs: Record<string, Record<string, PersonalBest>>; // envKey -> benchName -> best
}

export function loadLedger(): PerfLedger {
  try {
    if (existsSync(LEDGER_PATH)) {
      const parsed = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as PerfLedger;
      if (parsed && parsed.version === 1 && parsed.envs) return parsed;
    }
  } catch {
    // corrupt or unreadable — start fresh rather than crash a perf run
  }
  return { version: 1, envs: {} };
}

export function saveLedger(ledger: PerfLedger): void {
  mkdirSync(join(os.homedir(), ".freecode"), { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

export function ledgerPath(): string {
  return LEDGER_PATH;
}

export function gitCommit(): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || undefined;
  } catch {
    return undefined;
  }
}

export type Verdict = "new" | "best" | "regression" | "neutral";

export interface Comparison {
  verdict: Verdict;
  deltaPct: number; // (current - best) / best * 100; negative = faster
  significant: boolean;
  best?: PersonalBest;
}

// The heart of the noise rejection. A shift counts only if it exceeds the
// jitter band: the larger of (a) a minimum relative threshold, so we never chase
// sub-percent imperceptible changes, and (b) k times the combined MAD of the two
// runs, so a result that's within normal run-to-run variation is called a tie.
export function compare(
  current: BenchStats,
  best: PersonalBest | undefined,
  cfg: { relMin?: number; k?: number } = {},
): Comparison {
  if (!best) return { verdict: "new", deltaPct: 0, significant: false };
  const relMin = cfg.relMin ?? 0.02; // 2% floor
  const k = cfg.k ?? 3;
  const delta = current.median - best.median;
  const deltaPct = best.median > 0 ? (delta / best.median) * 100 : 0;
  const band = Math.max(relMin * best.median, k * (best.mad + current.mad));
  const significant = Math.abs(delta) > band;
  const verdict: Verdict = significant ? (delta < 0 ? "best" : "regression") : "neutral";
  return { verdict, deltaPct, significant, best };
}

/** A personal best snapshot from the current run's stats. */
export function toBest(stats: BenchStats, commit?: string): PersonalBest {
  return { median: stats.median, min: stats.min, mad: stats.mad, ts: new Date().toISOString(), commit };
}
