import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(10_000).optional(),
});

const MAX_BYTES = 512_000;

export const FileReadTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "FileRead",
  description: "Read a file from disk. Returns content with optional line offset and limit. Binary or oversized files report an error.",
  schema: ArgsSchema,
  permission: "safe",
  async run(args, ctx) {
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
    if (!existsSync(abs)) {
      return { ok: false, output: "", error: `File not found: ${args.path}` };
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      return { ok: false, output: "", error: `Path is a directory, not a file: ${args.path}` };
    }
    if (stat.size > MAX_BYTES) {
      return { ok: false, output: "", error: `File too large (${stat.size} bytes; max ${MAX_BYTES})` };
    }
    let text: string;
    try {
      const buf = readFileSync(abs);
      // Binary heuristic: a NUL byte in the first 8KB means it isn't UTF-8 text.
      if (buf.subarray(0, 8192).includes(0)) {
        return { ok: false, output: "", error: `Binary file (not UTF-8 text): ${args.path}` };
      }
      text = buf.toString("utf8");
    } catch (err) {
      return { ok: false, output: "", error: `Failed to read: ${String(err)}` };
    }
    const lines = text.split("\n");
    const start = args.offset ?? 0;
    const end = args.limit ? start + args.limit : lines.length;
    const slice = lines.slice(start, end);
    const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(6, " ")}\t${l}`).join("\n");
    return { ok: true, output: numbered, metadata: { totalLines: lines.length, bytes: stat.size, shown: slice.length } };
  },
};
