// One headless agent run, output pushed to a caller-supplied sink. Both the
// `--print` path (sink → stdout/stderr) and a background job (sink → log file)
// use this, so they can't drift apart. Returns the final assistant text and
// whether the run completed cleanly.
import { loadConfig, type CliFlags } from "../config/loader";
import { buildProvider } from "../providers/registry";
import { buildToolRegistry } from "../tools/registry";
import { createPermissionEngine, type ApprovalCallback } from "../permissions/modes";
import { runAgentLoop } from "./loop";
import { contextWindowFor } from "./pricing";
import { resolveVerify, resolveQuickVerify } from "./verify";
import { createAgentTool } from "../tools/agent";
import { extractAttachments } from "./attachments";
import { newSession, resumeSession, appendEvent, readSession, readConversationState, writeConversationState, type Session } from "../session/manager";
import { historyFromEvents } from "../session/history";
import { McpManager } from "../mcp/manager";
import { nowIso } from "../utils/ids";

export type Sink = (chunk: string, stream: "out" | "err") => void;

export interface HeadlessOptions {
  prompt: string;
  flags: CliFlags;
  cwd?: string;
  sink: Sink;
  signal?: AbortSignal;
}

export interface HeadlessResult {
  ok: boolean;
  finalText: string;
}

export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const cwd = opts.cwd ?? process.cwd();
  const config = loadConfig({ flags: opts.flags });
  const provider = buildProvider(config);
  const tools = buildToolRegistry({
    webSearch: {
      tavilyKey: process.env.TAVILY_API_KEY,
      exaKey: process.env.EXA_API_KEY,
      firecrawlKey: process.env.FIRECRAWL_API_KEY,
      defaultBackend: config.webSearchProvider,
    },
  });

  const mcp = new McpManager();
  await mcp.startAll(config.mcpServers);
  const summary = mcp.summary();
  if (summary) opts.sink(`[${summary}]\n`, "err");
  tools.push(...mcp.tools);

  const { images, files, notes } = extractAttachments(opts.prompt, cwd);
  for (const n of notes) opts.sink(`[attachment] ${n}\n`, "err");
  const effectivePrompt = files.length
    ? opts.prompt + "\n\n" + files.map((f) => `Contents of ${f.path}:\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
    : opts.prompt;

  const session: Session = opts.flags.resume
    ? resumeSession(cwd, opts.flags.resume) ?? newSession(cwd)
    : newSession(cwd);
  // Load prior context on resume (full provider-format state if persisted, else
  // the text-only rebuild) BEFORE appending this turn's prompt, so `--resume`
  // continues the conversation instead of starting the model off blank.
  const priorHistory = opts.flags.resume
    ? readConversationState(session) ?? historyFromEvents(readSession(session))
    : [];
  appendEvent(session, { kind: "user", text: opts.prompt, ts: nowIso() });

  const allow = (async () => "allow") as ApprovalCallback;
  const permission = createPermissionEngine(config.permissionMode, allow);
  tools.push(createAgentTool(() => ({
    provider, model: config.model, tools, permission, promptUser: allow,
    hooks: config.hooks, contextWindow: contextWindowFor(config.model),
  })));

  let finalText = "";
  let ok = true;
  try {
    const result = await runAgentLoop({
      provider,
      tools,
      model: config.model,
      maxTurns: config.maxTurns,
      prompt: effectivePrompt,
      images,
      history: priorHistory,
      contextWindow: contextWindowFor(config.model),
      contextThreshold: config.contextThreshold,
      enablePromptCache: config.enablePromptCache,
      enableExtendedThinking: config.enableExtendedThinking,
      hooks: config.hooks,
      verifyMode: config.verifyMode,
      verifyPlan: config.verifyMode === "strict" ? resolveVerify(cwd, config.verify) : config.verifyMode === "on" ? resolveQuickVerify(cwd) : undefined,
      permission,
      promptUser: allow,
      signal: opts.signal,
      onEvent: (e) => {
        if (e.type === "text_delta" && e.text) {
          finalText += e.text;
          opts.sink(e.text, "out");
        } else if (e.type === "tool_call" && e.call) {
          opts.sink(`\n[tool] ${e.call.name}(${JSON.stringify(e.call.arguments).slice(0, 120)})\n`, "err");
        } else if (e.type === "tool_result" && e.result) {
          opts.sink(`[result] ok=${e.result.ok} bytes=${e.result.output.length}\n`, "err");
        } else if (e.type === "compacted" && e.text) {
          opts.sink(`\n[${e.text}]\n`, "err");
        } else if (e.type === "verify" && e.text) {
          opts.sink(`\n${e.text}\n`, "err");
        } else if (e.type === "ledger" && e.ledger) {
          const L = e.ledger;
          if (L.verified.length) opts.sink(`\n✓ verified  ${L.verified.join("; ")}`, "err");
          if (L.observed.length) opts.sink(`\n· observed  ${L.observed.join("; ")}`, "err");
          if (L.believed.length) opts.sink(`\n~ believed  ${L.believed.join("; ")}`, "err");
          opts.sink("\n", "err");
        } else if (e.type === "error" && e.error) {
          ok = false;
          opts.sink(`\n[error] ${e.error}\n`, "err");
        }
      },
    });
    if (finalText.trim()) appendEvent(session, { kind: "assistant", text: finalText, ts: nowIso() });
    writeConversationState(session, result.messages); // so a later --resume restores full context
  } catch (err) {
    ok = false;
    opts.sink(`\n[error] ${err instanceof Error ? err.message : String(err)}\n`, "err");
  } finally {
    await mcp.stopAll();
  }
  return { ok, finalText: finalText.trim() };
}
