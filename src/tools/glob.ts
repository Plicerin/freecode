import fg from "fast-glob";
import { z } from "zod";
import { getEnv } from "../utils/env";
import type { Tool } from "./types";

// Like Grep, a Glob over a huge tree can stall for a long time (it's the read-only
// investigation plan mode leans on). Bound how long the AGENT waits — the walk may
// finish in the background, but the turn isn't frozen on it.
export function globTimeoutMs(): number {
  const n = Number(getEnv("FREECODE_GLOB_TIMEOUT_MS"));
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

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
      const walk = fg(args.pattern, {
        cwd,
        dot: args.dot ?? false,
        onlyFiles: args.onlyFiles ?? true,
        onlyDirectories: args.onlyDirs ?? false,
        ignore: args.ignore ?? ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/.cache/**"],
        absolute: false,
      });
      // Don't let the turn hang on a huge enumeration: cap the wait.
      const matches = await Promise.race([
        walk,
        new Promise<null>((r) => setTimeout(() => r(null), globTimeoutMs())),
      ]);
      if (matches === null) {
        return {
          ok: true,
          output: `[glob stopped after ${Math.round(globTimeoutMs() / 1000)}s — too many paths to walk. Narrow the \`cwd\` or use a more specific pattern.]`,
          metadata: { timedOut: true },
        };
      }
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
