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
  pattern: z.string().min(1).describe("A GLOB over file PATHS, e.g. `**/*.ts`, `src/**`, `*.json` — NOT a regex. Matches filenames/paths; to search file CONTENTS use Grep instead."),
  cwd: z.string().describe("Directory to glob from (defaults to the working directory).").optional(),
  ignore: z.array(z.string()).describe("Extra glob patterns to exclude, on top of .gitignore.").optional(),
  dot: z.boolean().describe("Include dotfiles / dot-directories (hidden entries).").optional(),
  onlyFiles: z.boolean().describe("Return only files (exclude directories).").optional(),
  onlyDirs: z.boolean().describe("Return only directories (exclude files).").optional(),
  limit: z.number().int().positive().max(10_000).describe("Cap on the number of paths returned.").optional(),
});

export const GlobTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "Glob",
  description: "Find files by NAME/PATH using a glob (e.g. **/*.ts). Respects .gitignore. Use to discover files before reading or editing. To search file CONTENTS, use Grep, not this.",
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
