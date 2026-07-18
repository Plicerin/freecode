import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_DIR } from "../utils/paths";
import { VERSION } from "../version";
import { debug } from "../utils/debug";

// npm-install self-update notifier. On an interactive launch we ask npm (at most
// once a day) whether a newer @vrocket/freecode has been published and, if so,
// print a one-line nudge. This exists because the OLD distribution model — an
// auto-`git pull` source clone — silently froze when a pull failed, so machines
// ran months-old code without anyone knowing. npm makes "am I current?" a real,
// answerable question; this makes the answer visible without any git/Bun/clone.

const PKG = "@vrocket/freecode";
// The tiny dist-tags endpoint (just {"latest":"x.y.z"}), not the full packument.
const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@vrocket%2Ffreecode/dist-tags";
const DEFAULT_STAMP = join(APP_DIR, "update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day is plenty

/** The x.y.z core of a version, dropping any `-dev` pre-release or `+sha` build
 *  suffix: "0.1.3+94933e4" -> "0.1.3", "0.1.3-dev+abc" -> "0.1.3". */
export function baseVersion(v: string): string {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : v.trim();
}

/** True iff `latest` is a strictly newer x.y.z than `current` (build/pre-release
 *  suffixes ignored). Anything un-parseable → false, so we never nag on garbage. */
export function isNewer(latest: string, current: string): boolean {
  const a = baseVersion(latest).split(".").map(Number);
  const b = baseVersion(current).split(".").map(Number);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

/** Running from a source checkout (`bun run src/cli.tsx`) rather than an npm
 *  install — only that path carries a `-dev` tag (see version.ts). Those users
 *  update with `git pull`, so the npm notifier doesn't apply to them. */
export function isSourceRun(version: string = VERSION): boolean {
  return version.includes("-dev");
}

interface Stamp { checkedAt: number; latest?: string }

function readStamp(path: string): Stamp {
  try { return JSON.parse(readFileSync(path, "utf8")) as Stamp; } catch { return { checkedAt: 0 }; }
}
function writeStamp(path: string, s: Stamp): void {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(s)); } catch { /* best effort */ }
}

/** Ask npm for the current `latest` dist-tag. Null on any failure (offline,
 *  timeout, unpublished) — a local-only user must never see an error for this. */
export async function fetchLatestFromNpm(): Promise<string | null> {
  try {
    const resp = await fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { latest?: string };
    return typeof json.latest === "string" ? json.latest : null;
  } catch (err) {
    debug.warn("update check fetch failed", String(err));
    return null;
  }
}

export interface UpdateCheckOptions {
  now?: number;
  force?: boolean;
  version?: string;
  stampPath?: string;
  fetchLatest?: () => Promise<string | null>;
  env?: Record<string, string | undefined>;
}

/**
 * The newer published version string, or null. Throttled to once/day via a stamp
 * file (within the window it compares against the cached value with no network),
 * silent on every failure, and a no-op for source runs and when
 * FREECODE_NO_UPDATE_CHECK=1. Never throws; the fetch is capped at 3s. All
 * dependencies are injectable so this is testable without network or the clock.
 */
export async function checkForUpdate(opts: UpdateCheckOptions = {}): Promise<string | null> {
  const env = opts.env ?? process.env;
  if (env.FREECODE_NO_UPDATE_CHECK === "1") return null;
  const version = opts.version ?? VERSION;
  if (isSourceRun(version)) return null;
  const now = opts.now ?? Date.now();
  const stampPath = opts.stampPath ?? DEFAULT_STAMP;
  const fetchLatest = opts.fetchLatest ?? fetchLatestFromNpm;
  const stamp = readStamp(stampPath);
  let latest = stamp.latest ?? null;
  if (opts.force || now - stamp.checkedAt >= CHECK_INTERVAL_MS) {
    const fetched = await fetchLatest();
    if (fetched) { latest = fetched; writeStamp(stampPath, { checkedAt: now, latest }); }
    else if (!latest) return null; // fetch failed and nothing cached — stay quiet
  }
  return latest && isNewer(latest, version) ? latest : null;
}

/** The upgrade command to suggest — used by the REPL notice and `freecode update`. */
export const UPDATE_HINT = `freecode update  (or: npm i -g ${PKG}@latest)`;
export { PKG as PACKAGE_NAME };
