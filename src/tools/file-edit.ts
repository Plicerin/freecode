import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { createTwoFilesPatch, applyPatch } from "diff";
import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  replaceAll: z.boolean().optional(),
  unifiedDiff: z.string().min(1).optional(),
}).refine((a) => (a.oldText !== undefined && a.newText !== undefined) || a.unifiedDiff, {
  message: "Provide either (oldText + newText) or unifiedDiff",
});

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
  async run(args, ctx) {
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
    if (!existsSync(abs)) {
      return { ok: false, output: "", error: `File not found: ${args.path}` };
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
      try {
        writeFileSync(abs, updated, "utf8");
      } catch (err) {
        return { ok: false, output: "", error: `Write failed: ${String(err)}` };
      }
      const diff = createTwoFilesPatch(args.path, args.path, fileLF, updatedLF, "before", "after");
      const note = located.flexible ? "(matched ignoring indentation/whitespace) " : "";
      return { ok: true, output: note + diff, metadata: { mode: "replace", replacements: args.replaceAll ? matches : 1, eol: eol === "\r\n" ? "crlf" : "lf", flexible: located.flexible } };
    }

    if (args.unifiedDiff) {
      // applyPatch (singular) is synchronous and returns the patched string,
      // or false if the patch doesn't apply cleanly.
      const result = applyPatch(original, args.unifiedDiff);
      if (result === false) {
        return { ok: false, output: "", error: "Patch did not apply cleanly against the current file contents" };
      }
      try {
        writeFileSync(abs, result, "utf8");
      } catch (err) {
        return { ok: false, output: "", error: `Write failed: ${String(err)}` };
      }
      const diff = createTwoFilesPatch(args.path, args.path, original, result, "before", "after");
      return { ok: true, output: diff, metadata: { mode: "diff" } };
    }

    return { ok: false, output: "", error: "No edit payload provided" };
  },
};
