import { writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Write a file atomically: write a temp sibling, then rename over the target
 *  (atomic on the same volume). A crash — or a second freecode instance writing
 *  concurrently — mid-write leaves the OLD file intact instead of a truncated/torn
 *  one. Critical for the config JSON that readers fail-soft to `{}` on a parse
 *  error: a torn write would otherwise silently wipe the user's whole config.
 *  (This prevents CORRUPTION; concurrent writers are still last-write-wins.) */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}
