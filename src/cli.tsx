import { Command } from "commander";
import { type CliFlags } from "./config/loader";
import { debug } from "./utils/debug";
import { VERSION } from "./version";

// Default to the PRODUCTION React build. React's DEV build emits performance-track
// measures on every commit that Node's timeline never frees → a long TUI session
// leaks to GBs (the OOM root cause). The bundle is compiled production via
// build.mjs; this covers SOURCE runs (`bun run src/cli.tsx`), which load React
// from node_modules at runtime — and it runs before the dynamic import of the
// REPL (and thus React). A dev can opt back into dev React with NODE_ENV=development.
// Bracket form so esbuild's `process.env.NODE_ENV` define doesn't rewrite the assignment.
if (!process.env["NODE_ENV"]) process.env["NODE_ENV"] = "production";

interface ParsedArgs {
  prompt?: string;
  print?: boolean;
  resume?: string;
  serve?: boolean;
  port?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  permissionMode?: "manual" | "auto" | "bypass";
  theme?: "dark" | "light";
  maxTurns?: number;
  maxRpm?: number;
  webSearchProvider?: "duckduckgo" | "tavily" | "exa" | "firecrawl";
  thinking?: boolean;
  verifyMode?: "off" | "on" | "strict";
  bg?: boolean;
}

const program = new Command();
program
  .name("freecode")
  .description("Provider-agnostic coding agent CLI (REPL + headless)")
  .version(VERSION)
  .option("-p, --print", "Headless: print response to stdout and exit", false)
  .option("--prompt <text>", "Prompt to send (used with --print)")
  .option("--resume <session-id>", "Resume a previous session")
  .option("--serve", "Start gRPC server (binds --port)", false)
  .option("--port <n>", "gRPC server port", "50051")
  .option("--provider <id>", "Override provider (anthropic|openai|gemini|github-models|bedrock|vertex|ollama|lmstudio|llama-server|nim|deepseek|openrouter)")
  .option("--model <id>", "Override model")
  .option("--base-url <url>", "Override base URL")
  .option("--api-key <key>", "Override API key")
  .option("--permission-mode <mode>", "manual|auto|bypass")
  .option("--theme <name>", "dark|light")
  .option("--max-turns <n>", "Maximum agent loop turns", (v) => Number.parseInt(v, 10))
  .option("--max-rpm <n>", "Throttle to N provider requests per minute (MRM; 0 = off)", (v) => Number.parseInt(v, 10))
  .option("--web-search <provider>", "duckduckgo|tavily|exa|firecrawl")
  .option("--thinking", "Enable extended thinking / reasoning", false)
  .option("--verify-mode <mode>", "off|on|strict (auto-verify after changes)")
  .option("--bg", "Run the prompt as a detached background job and exit", false);

async function main(): Promise<void> {
  // `freecode auth …` manages the encrypted key vault (handled before commander).
  if (process.argv[2] === "auth") {
    const { runAuth } = await import("./commands/auth");
    await runAuth(process.argv.slice(3));
    return;
  }
  // `freecode bench …` races the hot-path performance ledger (the ghost).
  if (process.argv[2] === "bench") {
    const { runBenchCommand } = await import("./commands/bench");
    await runBenchCommand(process.argv.slice(3));
    return;
  }
  // `freecode probe [prompt] [--tools]` — send ONE real request to the configured
  // provider and print the exact request body + streamed response, no agent loop.
  if (process.argv[2] === "probe") {
    const { runProbe } = await import("./commands/probe");
    await runProbe(process.argv.slice(3));
    return;
  }
  // `freecode resume <session-id>` — SPEC §I subcommand form of --resume.
  if (process.argv[2] === "resume") {
    const { startRepl } = await import("./commands/repl");
    await startRepl({ resumeId: process.argv[3], flags: {} });
    return;
  }
  // `freecode update` — self-update the global npm install (git pull for a clone).
  if (process.argv[2] === "update") {
    const { runUpdate } = await import("./commands/update");
    process.exit(await runUpdate());
  }
  // `freecode bg-exec <id>` — the hidden worker the detached background child re-enters.
  if (process.argv[2] === "bg-exec") {
    const { runBgExec } = await import("./commands/background-cli");
    await runBgExec(process.argv.slice(3));
    return;
  }
  // `freecode bg <run|list|logs|status|stop>` — manage background jobs.
  if (process.argv[2] === "bg" || process.argv[2] === "agents") {
    const { runBackgroundCommand } = await import("./commands/background-cli");
    const code = await runBackgroundCommand(process.argv.slice(3), {});
    process.exit(code);
  }
  await program.parseAsync(process.argv);
  const opts = program.opts<ParsedArgs>();
  const flags: CliFlags = {
    provider: opts.provider as CliFlags["provider"],
    model: opts.model,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    permissionMode: opts.permissionMode,
    theme: opts.theme,
    maxTurns: opts.maxTurns,
    maxRequestsPerMinute: opts.maxRpm,
    webSearchProvider: opts.webSearchProvider,
    enableExtendedThinking: opts.thinking ? true : undefined,
    verifyMode: opts.verifyMode,
    print: opts.print,
    resume: opts.resume,
    port: opts.port ? Number.parseInt(opts.port, 10) : undefined,
  };

  if (opts.serve) {
    const { startServer } = await import("./commands/serve");
    await startServer({ port: Number.parseInt(String(opts.port ?? "50051"), 10) });
    return;
  }

  if (opts.bg) {
    const prompt = (opts.prompt ?? "").trim();
    if (!prompt) {
      console.error("--bg requires --prompt <text>");
      process.exit(2);
    }
    const { startBackground } = await import("./background/runner");
    const job = startBackground(prompt, flags);
    console.log(`Started background job ${job.id} (pid ${job.pid ?? "?"}). Follow: freecode bg logs ${job.id}`);
    return;
  }

  if (opts.print) {
    const prompt = (opts.prompt ?? "").trim();
    if (!prompt) {
      console.error("--print requires --prompt <text>");
      process.exit(2);
    }
    await runPrint({ prompt, flags });
    return;
  }

  const { startRepl } = await import("./commands/repl");
  await startRepl({ initialPrompt: opts.prompt, resumeId: opts.resume, flags });
}

async function runPrint({ prompt, flags }: { prompt: string; flags: CliFlags }): Promise<void> {
  const { runHeadless } = await import("./agent/headless");
  await runHeadless({
    prompt,
    flags,
    sink: (chunk, stream) => (stream === "out" ? process.stdout : process.stderr).write(chunk),
  });
  process.stdout.write("\n");
}

main().catch((err) => {
  debug.error("fatal", String(err));
  console.error(`[freecode] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
