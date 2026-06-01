import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  showLineNumbers: z.boolean().optional(),
  maxResults: z.number().int().positive().max(5000).optional(),
  contextLines: z.number().int().min(0).max(50).optional(),
});

export interface GrepOptions {
  ripgrepPath?: string;
}

export function createGrepTool(opts: GrepOptions = {}): Tool<z.infer<typeof ArgsSchema>> {
  const rg = opts.ripgrepPath ?? "rg";
  return {
    name: "Grep",
    description: "Search file contents with ripgrep. Respects .gitignore by default. Returns matching lines with optional context.",
    schema: ArgsSchema,
    permission: "safe",
    async run(args, ctx) {
      const flags: string[] = ["--no-heading", "--line-number"];
      if (args.ignoreCase) flags.push("-i");
      flags.push("--no-config");
      flags.push("-g", "!.git/", "-g", "!node_modules/", "-g", "!dist/");
      if (args.glob) flags.push("-g", args.glob);
      if (args.contextLines) flags.push("-C", String(args.contextLines));
      const target = args.path ?? ctx.cwd;
      const cmd = [rg, ...flags, "--", args.pattern, target];
      return new Promise((resolveResult) => {
        const child = spawn(cmd[0]!, cmd.slice(1), { cwd: ctx.cwd, signal: ctx.signal });
        let out = "";
        let err = "";
        let outBytes = 0;
        const cap = 500_000;
        child.stdout?.on("data", (b: Buffer) => {
          outBytes += b.length;
          if (outBytes <= cap) out += b.toString("utf8");
        });
        child.stderr?.on("data", (b: Buffer) => { err += b.toString("utf8"); });
        child.on("error", (e) => resolveResult({ ok: false, output: "", error: `rg failed: ${e.message}` }));
        child.on("close", (code) => {
          if (code === 0 || code === 1) {
            const lines = args.maxResults ? out.split("\n").slice(0, args.maxResults).join("\n") : out;
            return resolveResult({
              ok: true,
              output: lines || "(no matches)",
              metadata: { matches: out.split("\n").filter(Boolean).length, truncated: outBytes > cap },
            });
          }
          resolveResult({ ok: false, output: "", error: `rg exit ${code}: ${err}` });
        });
      });
    },
  };
}
