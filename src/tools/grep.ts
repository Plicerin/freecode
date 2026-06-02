import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types";

const ArgsSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  showLineNumbers: z.boolean().optional(),
  maxResults: z.number().int().positive().max(5000).optional(),
  contextLines: z.number().int().min(0).max(50).optional(),
});

type Args = z.infer<typeof ArgsSchema>;

export interface GrepOptions {
  ripgrepPath?: string;
}

const IGNORE = ["**/.git/**", "**/node_modules/**", "**/dist/**"];
const NUL = String.fromCharCode(0);

export function createGrepTool(opts: GrepOptions = {}): Tool<Args> {
  const rg = opts.ripgrepPath ?? "rg";
  // Per-instance: remember whether this rg binary is available so we don't
  // repeatedly pay a failed spawn once we've learned it's missing.
  let rgAvailable: boolean | null = null;
  return {
    name: "Grep",
    description: "Search file contents (ripgrep when available, built-in fallback otherwise). Skips .git/, node_modules/, dist/. Returns matching lines.",
    schema: ArgsSchema,
    permission: "safe",
    async run(args, ctx) {
      if (rgAvailable !== false) {
        const viaRg = await tryRipgrep(rg, args, ctx);
        if (viaRg) {
          rgAvailable = true;
          return viaRg;
        }
        rgAvailable = false;
      }
      return jsGrep(args, ctx);
    },
  };
}

/** Run ripgrep; resolves null if rg is unavailable (so the caller can fall back). */
function tryRipgrep(rg: string, args: Args, ctx: ToolContext): Promise<ToolResult | null> {
  const flags: string[] = ["--no-heading", "--line-number", "--no-config"];
  if (args.ignoreCase) flags.push("-i");
  for (const ig of [".git/", "node_modules/", "dist/"]) flags.push("-g", `!${ig}`);
  if (args.glob) flags.push("-g", args.glob);
  if (args.contextLines) flags.push("-C", String(args.contextLines));
  const target = args.path ?? ctx.cwd;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(rg, [...flags, "--", args.pattern, target], { cwd: ctx.cwd, signal: ctx.signal });
    } catch {
      return resolve(null);
    }
    let out = "";
    let outBytes = 0;
    let err = "";
    const cap = 500_000;
    child.stdout?.on("data", (b: Buffer) => {
      outBytes += b.length;
      if (outBytes <= cap) out += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => { err += b.toString("utf8"); });
    child.on("error", (e: NodeJS.ErrnoException) => {
      // ENOENT => ripgrep isn't installed; signal fallback. Other errors surface.
      if (e.code === "ENOENT") return resolve(null);
      resolve({ ok: false, output: "", error: `rg failed: ${e.message}` });
    });
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        const lines = args.maxResults ? out.split("\n").slice(0, args.maxResults).join("\n") : out;
        return resolve({
          ok: true,
          output: lines || "(no matches)",
          metadata: { engine: "ripgrep", matches: out.split("\n").filter(Boolean).length, truncated: outBytes > cap },
        });
      }
      resolve({ ok: false, output: "", error: `rg exit ${code}: ${err}` });
    });
  });
}

/** Pure-JS fallback search — used when ripgrep isn't on PATH. */
async function jsGrep(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const target = args.path ?? ctx.cwd;
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
  } catch {
    // Invalid regex => treat the pattern as a literal string.
    const escaped = args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, args.ignoreCase ? "i" : "");
  }

  let files: string[];
  try {
    const st = await stat(target);
    if (st.isFile()) {
      files = [target];
    } else {
      const bare = args.glob;
      const pattern = bare ? (bare.includes("/") ? bare : `**/${bare}`) : "**/*";
      files = await fg(pattern, {
        cwd: target,
        ignore: IGNORE,
        dot: true,
        onlyFiles: true,
        absolute: true,
        suppressErrors: true,
        followSymbolicLinks: false,
      });
    }
  } catch (e) {
    return { ok: false, output: "", error: `search failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const limit = args.maxResults ?? 1000;
  const context = args.contextLines ?? 0;
  const results: string[] = [];
  let matchCount = 0;
  let scanned = 0;

  for (const file of files) {
    if (matchCount >= limit || scanned >= 5000) break;
    scanned += 1;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes(NUL)) continue; // skip binary files
    const lines = content.split("\n");
    const rel = relative(ctx.cwd, file) || file;
    const emitted = new Set<number>();
    for (let i = 0; i < lines.length && matchCount < limit; i++) {
      if (!regex.test(lines[i]!)) continue;
      const from = Math.max(0, i - context);
      const to = Math.min(lines.length - 1, i + context);
      for (let j = from; j <= to; j++) {
        if (emitted.has(j)) continue;
        emitted.add(j);
        const sep = j === i ? ":" : "-";
        results.push(`${rel}${sep}${j + 1}${sep}${lines[j]}`);
      }
      matchCount += 1;
    }
  }

  return {
    ok: true,
    output: results.length ? results.join("\n") : "(no matches)",
    metadata: { engine: "builtin", matches: matchCount, filesScanned: scanned, truncated: matchCount >= limit },
  };
}
