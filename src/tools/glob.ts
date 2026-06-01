import fg from "fast-glob";
import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  pattern: z.string().min(1),
  cwd: z.string().optional(),
  ignore: z.array(z.string()).optional(),
  dot: z.boolean().optional(),
  onlyFiles: z.boolean().optional(),
  onlyDirs: z.boolean().optional(),
  limit: z.number().int().positive().max(10_000).optional(),
});

export const GlobTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "Glob",
  description: "Find paths matching a glob. Respects .gitignore. Use to discover files before reading or editing.",
  schema: ArgsSchema,
  permission: "safe",
  async run(args, ctx) {
    const cwd = args.cwd ?? ctx.cwd;
    try {
      const matches = await fg(args.pattern, {
        cwd,
        dot: args.dot ?? false,
        onlyFiles: args.onlyFiles ?? true,
        onlyDirectories: args.onlyDirs ?? false,
        ignore: args.ignore ?? ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/.cache/**"],
        absolute: false,
      });
      const limited = args.limit ? matches.slice(0, args.limit) : matches;
      return {
        ok: true,
        output: limited.join("\n") || "(no matches)",
        metadata: { count: limited.length, total: matches.length },
      };
    } catch (err) {
      return { ok: false, output: "", error: `Glob failed: ${String(err)}` };
    }
  },
};
