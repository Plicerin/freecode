// `freecode bench` — run the hot-path benchmarks and race the ghost (this
// machine's stored personal bests). Reports new bests, regressions, and ties,
// and updates the ledger. This is the measurement floor the self-improvement
// loop stands on: nothing claims to be faster until it has out-run the ghost by
// more than the noise.

import chalk from "chalk";
import { HEX } from "../tui/theme";
import { OWL_MICRO } from "../tui/mascot";
import { runBench, type BenchStats } from "../perf/bench";
import { BENCHMARKS } from "../perf/benchmarks";
import {
  loadLedger,
  saveLedger,
  envFingerprint,
  envKey,
  compare,
  toBest,
  gitCommit,
  ledgerPath,
  type Comparison,
} from "../perf/ledger";

const teal = chalk.hex(HEX.success);
const amber = chalk.hex(HEX.warning);
const coral = chalk.hex(HEX.error);
const azure = chalk.hex(HEX.assistant);

function fmt(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(1)}µs`;
  if (ms < 1000) return `${ms.toFixed(3)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function verdictLine(stats: BenchStats, cmp: Comparison): string {
  const pct = `${cmp.deltaPct >= 0 ? "+" : ""}${cmp.deltaPct.toFixed(1)}%`;
  switch (cmp.verdict) {
    case "new":
      return chalk.dim("first run — recorded as the ghost");
    case "best":
      return teal(`▸ new personal best  (${pct} vs ${fmt(cmp.best!.median)})`);
    case "regression":
      return amber(`▸ ${pct} slower  (ghost ${fmt(cmp.best!.median)} · ${cmp.best!.commit ?? "?"})`);
    case "neutral":
      return chalk.dim(`▸ tied the ghost  (within noise, Δ${pct})`);
  }
}

export async function runBenchCommand(argv: string[]): Promise<void> {
  const save = !argv.includes("--no-save");
  const json = argv.includes("--json");
  const filterArg = argv.find((a) => a.startsWith("--filter="));
  const filter = filterArg ? filterArg.slice("--filter=".length) : undefined;

  const fp = envFingerprint();
  const key = envKey(fp);
  const ledger = loadLedger();
  const bests = (ledger.envs[key] ??= {});
  const commit = gitCommit();

  const run = BENCHMARKS.filter((b) => !filter || b.name.includes(filter));
  const rows: Array<{ name: string; why: string; stats: BenchStats; cmp: Comparison }> = [];

  for (const b of run) {
    const stats = await runBench(b.name, b.run);
    const cmp = compare(stats, bests[b.name]);
    rows.push({ name: b.name, why: b.why, stats, cmp });
    // Record a new best on first sighting or a significant improvement only —
    // a regression must NEVER overwrite the ghost, or the bar would erode.
    if (save && (cmp.verdict === "new" || cmp.verdict === "best")) {
      bests[b.name] = toBest(stats, commit);
    }
  }

  if (save) saveLedger(ledger);

  if (json) {
    process.stdout.write(JSON.stringify({ env: fp, results: rows }, null, 2) + "\n");
    return;
  }

  const beaten = rows.filter((r) => r.cmp.verdict === "best").length;
  const regressed = rows.filter((r) => r.cmp.verdict === "regression").length;

  process.stdout.write("\n");
  process.stdout.write(`  ${azure(OWL_MICRO)} ${chalk.bold("freecode bench")} ${chalk.dim("— racing the ghost")}\n`);
  process.stdout.write(`  ${chalk.dim(`${fp.cpu} · ${fp.cpus} cores · ${fp.runtime}`)}\n\n`);

  const width = Math.max(...rows.map((r) => r.name.length), 4);
  for (const r of rows) {
    process.stdout.write(`  ${azure(r.name.padEnd(width))}  ${fmt(r.stats.median).padStart(9)}  ${verdictLine(r.stats, r.cmp)}\n`);
    process.stdout.write(`  ${" ".repeat(width)}  ${chalk.dim(`±${fmt(r.stats.mad)} · ${r.why}`)}\n`);
  }

  process.stdout.write("\n");
  const summary =
    regressed > 0
      ? coral(`⚠ ${regressed} regression${regressed === 1 ? "" : "s"}`)
      : beaten > 0
        ? teal(`beat the ghost on ${beaten}/${rows.length}`)
        : chalk.dim("held the line");
  process.stdout.write(`  ${summary}  ${chalk.dim("· ledger " + ledgerPath())}\n\n`);
}
