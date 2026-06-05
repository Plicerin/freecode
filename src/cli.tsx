import { Command } from "commander";
import { loadConfig, type CliFlags } from "./config/loader";
import { buildProvider } from "./providers/registry";
import { buildToolRegistry } from "./tools/registry";
import { createPermissionEngine } from "./permissions/modes";
import { runAgentLoop } from "./agent/loop";
import { contextWindowFor } from "./agent/pricing";
import { resolveVerify, resolveQuickVerify } from "./agent/verify";
import { newSession, appendEvent, resumeSession, type Session } from "./session/manager";
import { type ApprovalCallback } from "./permissions/modes";
import { debug } from "./utils/debug";
import { setTimeout as wait } from "node:timers/promises";

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
  webSearchProvider?: "duckduckgo" | "tavily" | "exa" | "firecrawl";
  thinking?: boolean;
  verifyMode?: "off" | "on" | "strict";
}

const program = new Command();
program
  .name("freecode")
  .description("Provider-agnostic coding agent CLI (REPL + headless)")
  .version("0.1.0")
  .option("-p, --print", "Headless: print response to stdout and exit", false)
  .option("--prompt <text>", "Prompt to send (used with --print)")
  .option("--resume <session-id>", "Resume a previous session")
  .option("--serve", "Start gRPC server (binds --port)", false)
  .option("--port <n>", "gRPC server port", "50051")
  .option("--provider <id>", "Override provider (anthropic|openai|gemini|github-models|bedrock|vertex|ollama|lmstudio)")
  .option("--model <id>", "Override model")
  .option("--base-url <url>", "Override base URL")
  .option("--api-key <key>", "Override API key")
  .option("--permission-mode <mode>", "manual|auto|bypass")
  .option("--theme <name>", "dark|light")
  .option("--max-turns <n>", "Maximum agent loop turns", (v) => Number.parseInt(v, 10))
  .option("--web-search <provider>", "duckduckgo|tavily|exa|firecrawl")
  .option("--thinking", "Enable extended thinking / reasoning", false)
  .option("--verify-mode <mode>", "off|on|strict (auto-verify after changes)");

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
  // `freecode resume <session-id>` — SPEC §I subcommand form of --resume.
  if (process.argv[2] === "resume") {
    const { startRepl } = await import("./commands/repl");
    await startRepl({ resumeId: process.argv[3], flags: {} });
    return;
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
  const config = loadConfig({ flags });
  const provider = buildProvider(config);
  const tools = buildToolRegistry({
    webSearch: {
      tavilyKey: process.env.TAVILY_API_KEY,
      exaKey: process.env.EXA_API_KEY,
      firecrawlKey: process.env.FIRECRAWL_API_KEY,
      defaultBackend: config.webSearchProvider,
    },
  });

  const { McpManager } = await import("./mcp/manager");
  const mcp = new McpManager();
  await mcp.startAll(config.mcpServers);
  const summary = mcp.summary();
  if (summary) process.stderr.write(`[${summary}]\n`);
  tools.push(...mcp.tools);

  const { extractAttachments } = await import("./agent/attachments");
  const { images, files, notes } = extractAttachments(prompt, process.cwd());
  for (const n of notes) process.stderr.write(`[attachment] ${n}\n`);
  const effectivePrompt = files.length
    ? prompt + "\n\n" + files.map((f) => `Contents of ${f.path}:\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
    : prompt;

  const cwd = process.cwd();
  const session: Session = opts_or_new(flags.resume, cwd);
  appendEvent(session, { kind: "user", text: prompt, ts: new Date().toISOString() });
  const permission = createPermissionEngine(config.permissionMode, (async () => "allow") as ApprovalCallback);

  // Sub-agents (Tier A): the headless run can dispatch them too.
  const { createAgentTool } = await import("./tools/agent");
  const headlessPromptUser = (async () => "allow") as ApprovalCallback;
  tools.push(createAgentTool(() => ({
    provider, model: config.model, tools, permission, promptUser: headlessPromptUser,
    hooks: config.hooks, contextWindow: contextWindowFor(config.model),
  })));

  try {
    await runAgentLoop({
      provider,
      tools,
      model: config.model,
      maxTurns: config.maxTurns,
      prompt: effectivePrompt,
      images,
      contextWindow: contextWindowFor(config.model),
      contextThreshold: config.contextThreshold,
      enablePromptCache: config.enablePromptCache,
      enableExtendedThinking: config.enableExtendedThinking,
      hooks: config.hooks,
      verifyMode: config.verifyMode,
      verifyPlan: config.verifyMode === "strict" ? resolveVerify(cwd, config.verify) : config.verifyMode === "on" ? resolveQuickVerify(cwd) : undefined,
      permission,
      promptUser: (async () => "allow") as ApprovalCallback,
      onEvent: (e) => {
        if (e.type === "text_delta" && e.text) {
          process.stdout.write(e.text);
        } else if (e.type === "tool_call" && e.call) {
          process.stderr.write(`\n[tool] ${e.call.name}(${JSON.stringify(e.call.arguments).slice(0, 120)})\n`);
        } else if (e.type === "tool_result" && e.result) {
          process.stderr.write(`[result] ok=${e.result.ok} bytes=${e.result.output.length}\n`);
        } else if (e.type === "compacted" && e.text) {
          process.stderr.write(`\n[${e.text}]\n`);
        } else if (e.type === "verify" && e.text) {
          process.stderr.write(`\n${e.text}\n`);
        } else if (e.type === "ledger" && e.ledger) {
          const L = e.ledger;
          if (L.verified.length) process.stderr.write(`\n✓ verified  ${L.verified.join("; ")}`);
          if (L.observed.length) process.stderr.write(`\n· observed  ${L.observed.join("; ")}`);
          if (L.believed.length) process.stderr.write(`\n~ believed  ${L.believed.join("; ")}`);
          process.stderr.write("\n");
        } else if (e.type === "error" && e.error) {
          process.stderr.write(`\n[error] ${e.error}\n`);
        }
      },
    });
    process.stdout.write("\n");
  } finally {
    await mcp.stopAll();
  }
}

function opts_or_new(resumeId: string | undefined, cwd: string): Session {
  if (resumeId) {
    const s = resumeSession(cwd, resumeId);
    if (s) return s;
  }
  return newSession(cwd);
}

main().catch((err) => {
  debug.error("fatal", String(err));
  console.error(`[freecode] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
