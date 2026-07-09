import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { createTwoFilesPatch, applyPatch } from "diff";
import { z } from "zod";
import type { Tool } from "./types";
import { structuredWriteError } from "./structured-validate";

const ArgsSchema = z.object({
  // Optional: a unified diff carries its own +++/--- path, so we can derive it.
  path: z.string().min(1).describe("File to edit. Required UNLESS you pass a unified diff whose +++/--- header names the file.").optional(),
  oldText: z.string().describe("Exact existing text to replace (include enough surrounding lines to be unique). Pair with `newText`. Alternative to a diff.").optional(),
  newText: z.string().describe("Replacement text for `oldText`. Use \"\" to delete the matched text.").optional(),
  replaceAll: z.boolean().describe("Replace every occurrence of `oldText` instead of requiring it to be unique.").optional(),
  unifiedDiff: z.string().min(1).describe("A unified diff (--- / +++ / @@ hunks) to apply. Use INSTEAD of oldText/newText for multi-hunk edits.").optional(),
  // Models very commonly name the diff field `diff` — accept it as an alias
  // rather than rejecting a perfectly good patch on a naming nit.
  diff: z.string().min(1).describe("Alias for `unifiedDiff` — a unified diff to apply.").optional(),
}).refine((a) => (a.oldText !== undefined && a.newText !== undefined) || a.unifiedDiff || a.diff, {
  message: "Provide either (oldText + newText) or a unified diff",
}).refine((a) => a.path !== undefined || a.unifiedDiff !== undefined || a.diff !== undefined, {
  message: "Provide a `path` (a unified diff whose header names the file is also accepted)",
});

/** Pull the target path from a unified-diff header — prefer the `+++` (new) line,
 *  fall back to `---`; strip a leading a/ or b/ and any trailing tab+timestamp.
 *  Lets a self-describing diff work without a separate `path` arg. */
export function pathFromDiffHeader(diff: string): string | null {
  for (const re of [/^\+\+\+[ \t]+(.+)$/m, /^---[ \t]+(.+)$/m]) {
    const m = re.exec(diff);
    if (!m) continue;
    const p = m[1]!.split("\t")[0]!.trim().replace(/^[ab]\//, "");
    if (p && p !== "/dev/null") return p;
  }
  return null;
}

/** Recompute each `@@ -a,X +c,Y @@` hunk header's line counts from the ACTUAL
 *  body lines. Weak models get the body (the +/-/space lines) right but the
 *  header counts wrong, and the `diff` library THROWS on the mismatch ("Added
 *  line count did not match for hunk…") rather than applying. Rewriting the
 *  counts from the body — a no-op for an already-correct diff — makes the common
 *  malformed-header case apply cleanly. Start lines are preserved untouched. */
export function normalizeHunkCounts(diff: string): string {
  const lines = diff.split("\n");
  const hdr = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(hdr);
    if (!m) { out.push(lines[i]!); continue; }
    let oldC = 0, newC = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ")) break;
      const c = line[0];
      if (c === " ") { oldC++; newC++; }
      else if (c === "-") oldC++;
      else if (c === "+") newC++;
      else if (c === "\\") { /* "\ No newline at end of file" — not a content line */ }
      else break; // blank/unknown line ends the hunk body
    }
    out.push(`@@ -${m[1]},${oldC} +${m[2]},${newC} @@${m[3]}`);
  }
  return out.join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

const toLF = (s: string): string => s.replace(/\r\n/g, "\n");

// Strip a FileRead-style line-number gutter ("   12\t…") IF every non-empty line
// has one — the model sometimes copies numbered output into oldText verbatim.
function stripGutter(s: string): string {
  const gutter = /^\s*\d+\t/;
  const lines = s.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0 || !nonEmpty.every((l) => gutter.test(l))) return s;
  return lines.map((l) => l.replace(gutter, "")).join("\n");
}

// Literal single replace (no $-pattern interpretation, unlike String.replace).
function replaceOnce(haystack: string, needle: string, repl: string): string {
  const i = haystack.indexOf(needle);
  return i < 0 ? haystack : haystack.slice(0, i) + repl + haystack.slice(i + needle.length);
}

// Last-resort match: locate oldText ignoring each line's LEADING/TRAILING
// whitespace (the #1 reason edits fail — the model reconstructs a block with
// slightly different indentation). Returns the EXACT file substring to replace,
// but ONLY when the normalized block matches in exactly one place — never guess.
export function flexLocate(fileLF: string, oldText: string): string | null {
  const norm = (l: string) => l.trim();
  let oldLines = stripGutter(toLF(oldText)).split("\n");
  while (oldLines.length && oldLines[oldLines.length - 1]!.trim() === "") oldLines.pop();
  while (oldLines.length && oldLines[0]!.trim() === "") oldLines = oldLines.slice(1);
  if (oldLines.length === 0) return null;
  const fileLines = fileLF.split("\n");
  const normOld = oldLines.map(norm);
  const hits: number[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (norm(fileLines[i + j]!) !== normOld[j]) { ok = false; break; }
    }
    if (ok) hits.push(i);
    if (hits.length > 1) return null; // ambiguous → refuse rather than edit the wrong block
  }
  if (hits.length !== 1) return null;
  return fileLines.slice(hits[0]!, hits[0]! + oldLines.length).join("\n");
}

/**
 * Find oldText in the file, tolerating what makes exact matching fail in the real
 * world: CRLF vs LF line endings, a copied line-number gutter, and (as a last
 * resort) per-line indentation/whitespace drift. Matching is done in LF space;
 * the caller re-applies the file's real line endings on write. `flexible` flags
 * the indentation-tolerant path so callers can note it.
 */
function locateOldText(fileLF: string, oldText: string): { match: string; flexible: boolean } | null {
  for (const cand of [toLF(oldText), stripGutter(toLF(oldText))]) {
    if (cand && fileLF.includes(cand)) return { match: cand, flexible: false };
  }
  const flex = flexLocate(fileLF, oldText);
  return flex !== null ? { match: flex, flexible: true } : null;
}

export const FileEditTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "FileEdit",
  description: "Edit a file. Two modes: (1) oldText + newText string replace (oldText must be unique unless replaceAll is set), (2) unifiedDiff patch (from `diff -u`).",
  schema: ArgsSchema,
  permission: "confirm",
  // Weak models often fumble this call — emitting it with no args, or a path but
  // no edit — then fall back to rewriting the whole file. Give a pointed hint so
  // they correct course instead of flailing.
  correctionHint(rawArgs) {
    const a = (rawArgs ?? {}) as Record<string, unknown>;
    const hasDiff = typeof a.unifiedDiff === "string" || typeof a.diff === "string";
    if (!a.path && !hasDiff) {
      return "FileEdit needs a `path` plus EITHER `oldText`+`newText` (an exact snippet to find and its replacement) OR a unified diff. To write/replace the whole file instead, call FileWrite({path, content}).";
    }
    if (a.oldText === undefined && a.newText === undefined && !hasDiff) {
      return "You gave a path but no edit. Provide `oldText` (exact text to find) + `newText` (its replacement), or a unified diff (the `diff`/`unifiedDiff` field). To replace the ENTIRE file, use FileWrite({path, content}) instead.";
    }
    if ((a.oldText === undefined) !== (a.newText === undefined)) {
      return "`oldText` and `newText` must be given TOGETHER (find + replace). Add the missing one, or switch to a unified diff, or use FileWrite for a whole-file rewrite.";
    }
    return undefined;
  },
  async run(args, ctx) {
    const unified = args.unifiedDiff ?? args.diff;
    const path = args.path ?? (unified ? pathFromDiffHeader(unified) : undefined);
    if (!path) {
      return { ok: false, output: "", error: "No file path: pass `path`, or a unified diff whose +++/--- header names the file." };
    }
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
    if (!existsSync(abs)) {
      return { ok: false, output: "", error: `File not found: ${path}` };
    }
    const original = readFileSync(abs, "utf8");

    if (args.oldText !== undefined && args.newText !== undefined) {
      // Match in LF space (tolerating CRLF files + a copied line-number gutter),
      // then restore the file's real line endings on write.
      const eol = original.includes("\r\n") ? "\r\n" : "\n";
      const fileLF = toLF(original);
      const newLF = toLF(args.newText);
      const located = locateOldText(fileLF, args.oldText);
      if (located === null) {
        return { ok: false, output: "", error: "oldText not found in file (no unique match — even ignoring indentation). Re-read the file to get its CURRENT exact text (it may have changed since your last read), copy the lines verbatim WITHOUT the line-number prefix, and try again. For a big change, the unifiedDiff mode is more forgiving." };
      }
      const oldLF = located.match;
      const matches = countOccurrences(fileLF, oldLF);
      if (matches > 1 && !args.replaceAll) {
        return { ok: false, output: "", error: `oldText is not unique (${matches} matches). Add surrounding context to make it unique, or set replaceAll: true.` };
      }
      const updatedLF = args.replaceAll ? fileLF.split(oldLF).join(newLF) : replaceOnce(fileLF, oldLF, newLF);
      const updated = eol === "\r\n" ? updatedLF.replace(/\n/g, "\r\n") : updatedLF;
      const jsonError = structuredWriteError(path, updated);
      if (jsonError) {
        return { ok: false, output: "", error: jsonError };
      }
      try {
        writeFileSync(abs, updated, "utf8");
      } catch (err) {
        return { ok: false, output: "", error: `Write failed: ${String(err)}` };
      }
      const diff = createTwoFilesPatch(path, path, fileLF, updatedLF, "before", "after");
      const note = located.flexible ? "(matched ignoring indentation/whitespace) " : "";
      return { ok: true, output: note + diff, metadata: { mode: "replace", replacements: args.replaceAll ? matches : 1, eol: eol === "\r\n" ? "crlf" : "lf", flexible: located.flexible } };
    }

    if (unified) {
      // Recompute hunk header counts from the body first: weak models fumble the
      // `@@ -a,X +c,Y @@` counts, and the diff library THROWS on the mismatch
      // (surfacing a cryptic "Added line count did not match…"). applyPatch is
      // synchronous and returns the patched string, or false if the CONTEXT
      // doesn't match — but it can also throw on a malformed patch, so guard it.
      let result: string | false;
      try {
        result = applyPatch(original, normalizeHunkCounts(unified));
      } catch (err) {
        return { ok: false, output: "", error: `The unified diff is malformed (${String((err as Error)?.message ?? err)}). Re-read the file for its CURRENT exact lines, or use oldText + newText (an exact snippet and its replacement) instead — it's more forgiving than a hand-written diff.` };
      }
      if (result === false) {
        return { ok: false, output: "", error: "The unified diff didn't apply — its context lines don't match the current file (it may have changed, or the surrounding lines are off). Re-read the file to copy the exact lines, or switch to oldText + newText (an exact snippet and its replacement)." };
      }
      const jsonError = structuredWriteError(path, result);
      if (jsonError) {
        return { ok: false, output: "", error: jsonError };
      }
      try {
        writeFileSync(abs, result, "utf8");
      } catch (err) {
        return { ok: false, output: "", error: `Write failed: ${String(err)}` };
      }
      const diff = createTwoFilesPatch(path, path, original, result, "before", "after");
      return { ok: true, output: diff, metadata: { mode: "diff" } };
    }

    return { ok: false, output: "", error: "No edit payload provided" };
  },
};
