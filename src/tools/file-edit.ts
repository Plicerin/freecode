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
      const matches = countOccurrences(original, args.oldText);
      if (matches === 0) {
        return { ok: false, output: "", error: "oldText not found in file (no match)" };
      }
      if (matches > 1 && !args.replaceAll) {
        return { ok: false, output: "", error: `oldText is not unique (${matches} matches). Add surrounding context to make it unique, or set replaceAll: true.` };
      }
      const updated = args.replaceAll
        ? original.split(args.oldText).join(args.newText)
        : original.replace(args.oldText, args.newText);
      try {
        writeFileSync(abs, updated, "utf8");
      } catch (err) {
        return { ok: false, output: "", error: `Write failed: ${String(err)}` };
      }
      const diff = createTwoFilesPatch(args.path, args.path, original, updated, "before", "after");
      return { ok: true, output: diff, metadata: { mode: "replace", replacements: args.replaceAll ? matches : 1 } };
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
