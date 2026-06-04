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

/**
 * Find oldText in the file, tolerating the two things that make exact matching
 * fail in the real world: CRLF vs LF line endings (every multi-line edit on a
 * Windows file) and a copied line-number gutter. Matching is done in LF space;
 * the caller re-applies the file's real line endings on write.
 */
function locateOldText(fileLF: string, oldText: string): string | null {
  for (const cand of [toLF(oldText), stripGutter(toLF(oldText))]) {
    if (cand && fileLF.includes(cand)) return cand;
  }
  return null;
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
      const oldLF = locateOldText(fileLF, args.oldText);
      if (oldLF === null) {
        return { ok: false, output: "", error: "oldText not found in file (no match). Copy the exact text from the file (line endings are handled for you; do not include the line-number prefix from FileRead)." };
      }
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
      return { ok: true, output: diff, metadata: { mode: "replace", replacements: args.replaceAll ? matches : 1, eol: eol === "\r\n" ? "crlf" : "lf" } };
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
