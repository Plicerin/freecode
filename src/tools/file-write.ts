import { writeFileSync, mkdirSync, existsSync, statSync, renameSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirs: z.boolean().optional(),
});

export const FileWriteTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "FileWrite",
  description: "Write content to a file. Creates parent directories on request. Atomic via temp + rename.",
  schema: ArgsSchema,
  permission: "confirm",
  async run(args, ctx) {
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
    if (args.createDirs ?? true) {
      mkdirSync(dirname(abs), { recursive: true });
    } else {
      if (!existsSync(dirname(abs))) {
        return { ok: false, output: "", error: `Parent directory does not exist: ${dirname(abs)}` };
      }
    }
    const existed = existsSync(abs);
    const tmp = `${abs}.openclaude-tmp`;
    try {
      writeFileSync(tmp, args.content, "utf8");
      renameSync(tmp, abs);
    } catch (err) {
      return { ok: false, output: "", error: `Write failed: ${String(err)}` };
    }
    return {
      ok: true,
      output: `Wrote ${args.content.length} bytes to ${args.path}${existed ? " (overwrote existing)" : " (new file)"}`,
      metadata: { path: abs, bytes: args.content.length, existed },
    };
  },
};
