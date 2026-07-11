import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { closest } from "../utils/fuzzy";

/** When an absolute path doesn't exist, find the closest one that DOES by fixing
 *  a typo'd component (a stray space, a misspelling) against the real directory
 *  entries — e.g. `…\port\system s\river.py` → `…\port\systems\river.py`. Returns
 *  the corrected path, or null when there's no close match. This lets a "File not
 *  found" error name the right path so the model corrects, instead of re-emitting
 *  the same wrong path until the failure circuit-breaker trips. */
export function suggestPath(absPath: string): string | null {
  if (!absPath || existsSync(absPath)) return null;
  const parts = absPath.split(/[\\/]+/);

  // Establish the root and where the walkable components start.
  let cur: string;
  let i: number;
  if (parts[0] === "") { cur = sep; i = 1; } // POSIX absolute (/…)
  else if (/^[A-Za-z]:$/.test(parts[0] ?? "")) { cur = parts[0]! + sep; i = 1; } // Windows drive (C:\…)
  else return null; // relative path — nothing reliable to walk from
  if (!existsSync(cur)) return null;

  let corrected = false;
  for (; i < parts.length; i++) {
    const want = parts[i];
    if (!want) continue;
    const next = join(cur, want);
    if (existsSync(next)) { cur = next; continue; }
    // First missing component — fuzzy-match it against what's actually here.
    let entries: string[];
    try { entries = readdirSync(cur); } catch { return null; }
    const maxDist = Math.min(4, Math.max(2, Math.ceil(want.length / 3)));
    const match = closest(want, entries, maxDist);
    if (!match || match.toLowerCase() === want.toLowerCase()) return null;
    cur = join(cur, match);
    corrected = true;
    if (!existsSync(cur)) return null; // corrected component still isn't real → give up
  }
  return corrected && existsSync(cur) ? cur : null;
}
