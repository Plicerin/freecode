import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { createTwoFilesPatch, applyPatches } from "diff";
import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  unifiedDiff: z.string().min(1).optional(),
}).refine((a) => (a.oldText !== undefined && a.newText !== undefined) || a.unifiedDiff, {
  message: "Provide either (oldText + newText) or unifiedDiff",
});

export const FileEditTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "FileEdit",
  description: "Edit a file. Two modes: (1) oldText + newText string replace, (2) unifiedDiff patch (patch format from `diff -u`).",
  schema: ArgsSchema,
  permission: "confirm",
  async run(args, ctx) {
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
    if (!existsSync(abs)) {
      return { ok: false, output: "", error: `File not found: ${args.path}` };
    }
    const original = readFileSync(abs, "utf8");

    if (args.oldText !== undefined && args.newText !== undefined) {
      if (!original.includes(args.oldText)) {
        return { ok: false, output: "", error: "oldText not found in file (no match)" };
      }
      const updated = original.replace(args.oldText, args.newText);
      try {
        writeFileSync(abs, updated, "utf8");
      } catch (err) {
        return { ok: false, output: "", error: `Write failed: ${String(err)}` };
      }
      const diff = createTwoFilesPatch(args.path, args.path, original, updated, "before", "after");
      return { ok: true, output: diff, metadata: { mode: "replace", changedBytes: args.newText.length - args.oldText.length } };
    }

    if (args.unifiedDiff) {
      // Unified diff path: parse the patch and apply it.
      // The diff library requires a loadFile/patched/complete callback contract;
      // we use the synchronous in-memory variant.
      const result = applyPatches(args.unifiedDiff, {
        loadFile: (_idx: number, _cb: (err: Error | null, data?: string) => void) => original,
        patched: (_idx: number, _content: string, _cb: (err: Error | null) => void) => {},
        complete: (_err?: Error | null) => {},
      } as unknown as Parameters<typeof applyPatches>[1]);
      if (typeof result === "string" && result) {
        try {
          writeFileSync(abs, result, "utf8");
        } catch (err) {
          return { ok: false, output: "", error: `Write failed: ${String(err)}` };
        }
        return { ok: true, output: "Patch applied", metadata: { mode: "diff" } };
      }
      return { ok: false, output: "", error: "Patch did not apply cleanly" };
    }

    return { ok: false, output: "", error: "No edit payload provided" };
  },
};
