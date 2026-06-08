import React, { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { loadConfig, type CliFlags } from "../config/loader";
import { buildProvider } from "../providers/registry";
import { buildToolRegistry, toolListToSystemPrompt } from "../tools/registry";
import { createPermissionEngine, approvalDecisionForKey, type ApprovalCallback, type ApprovalDecision, type ApprovalRequest } from "../permissions/modes";
import { runAgentLoop } from "../agent/loop";
import { branch as gitBranch, commitPushPr, issue as ghIssue, prComments } from "./git-workflow";
import { createAgentTool } from "../tools/agent";
import { resolveAgentTypes } from "../agent/agent-types";
import { resolveSkills } from "../agent/skills";
import { resolveWorkflows, getWorkflow, runWorkflow, composeWorkflow, type WorkflowEvent } from "../agent/workflow";
import { filterChatModels, pickerWindow } from "../tui/model-picker";
import { matchCommands, resolveSubmit } from "../tui/slash-complete";
import { createApprovalQueue } from "../tui/approval-queue";
import { resolvePlugins, setPluginEnabled, installPlugin, uninstallPlugin } from "../plugins";
import { startBackground } from "../background/runner";
import { reapJobs } from "../background/registry";
import { formatJobLine } from "./background-cli";
import { analyzeSession, applyProposal, dedupeProposals, transcriptFromMessages, type Proposal } from "../agent/self-improve";
import { ensureStat, listStats, decayCandidates, verifyTrend, pruneArtifact } from "../agent/learn-stats";
import { readFileSync as readFileForLearn } from "node:fs";
import { ContextTracker } from "../agent/context";
import { priceFor, contextWindowFor } from "../agent/pricing";
import { contextBar, contextTone, formatTokens } from "../tui/context-bar";
import { extractAttachments } from "../agent/attachments";
import { summarizeConversation } from "../agent/summarize";
import { Vault } from "../config/vault";
import { loadCustomCommands, expandCommand } from "./custom-commands";
import { executeBench, formatBenchPlain } from "./bench";
import { previewToolResult } from "../tui/preview";
import { type Confidence, nextConfidence } from "../tui/confidence";
import { MarkdownBody } from "../tui/markdown-render";
import { logActivity, setActivityLog, activityState } from "../utils/activity";
import { closest } from "../utils/fuzzy";
import { resolveVerify, resolveQuickVerify, runVerify } from "../agent/verify";
import { newSession, appendEvent, resumeSession, readSession, setSessionTitle, listSessionMetas, type Session, type SessionMeta } from "../session/manager";
import { historyFromEvents } from "../session/history";
import { makeTheme } from "../tui/theme";
import { Mascot, OWL_MICRO, OWL_FRAMES, MASCOT_BIO } from "../tui/mascot";
import { debug } from "../utils/debug";
import type { Tool } from "../tools/types";
import type { ChatMessage } from "../providers/types";
import type { McpServerStatus } from "../mcp/manager";

export interface ReplOptions {
  flags?: CliFlags;
  resumeId?: string;
  initialPrompt?: string;
  extraTools?: Tool[];
  mcpStatus?: McpServerStatus[];
}

interface UiMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "ledger";
  text: string;
  toolName?: string;
  ok?: boolean;
}

const SLASH_COMMANDS = ["/model", "/models", "/new", "/resume", "/rename", "/context", "/cost", "/config", "/doctor", "/diff", "/commit", "/commit-push-pr", "/branch", "/issue", "/pr-comments", "/review", "/security-review", "/autofix-pr", "/explore", "/agents", "/skills", "/learn", "/workflows", "/ultraplan", "/bg", "/plugins", "/provider", "/plan", "/verify", "/bench", "/log", "/mcp", "/help", "/compact", "/about", "/exit"];

// Spinner frames — proof of life while a turn runs. Not the braille snake every
// other CLI ships: this is Bubo's eye. He holds your gaze, glances right, glances
// left, then blinks (upper lid down ◓ → shut ─ → up ◓) — a watchful eye scanning,
// fitting a tool whose whole identity is checking before it says "done".
// Swap-in alternatives (same render path):
//   iris pulse:  ["◌","◍","◉","●","◉","◍"]
//   scan sweep:  ["◴","◵","◶","◷"]
const SPINNER_FRAMES = ["◉", "◑", "◉", "◐", "◉", "◓", "─", "◓"];

// A streamed workflow event → one status line (or null to swallow it). Shared by
// /workflows and /ultraplan so both show live per-stage / per-task progress.
function workflowEventLine(e: WorkflowEvent): string | null {
  if (e.type === "stage_start") return `  ◐ stage ${e.index + 1}${e.name ? ` (${e.name})` : ""} — ${e.tasks} task${e.tasks > 1 ? "s" : ""} running…`;
  if (e.type === "task_activity") return `       ${e.agent ?? "general"} ${e.label}`;
  if (e.type === "task_done") return `     ${e.ok ? "✓" : "✗"} ${e.agent ?? "general"} done`;
  return null; // stage_done is implied by the next stage_start or the final output
}

// Compact relative time for the session picker.
function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const COMMAND_DESC: Record<string, string> = {
  "/model": "show or switch model",
  "/new": "start a fresh session",
  "/resume": "pick a session to resume (↑/↓)",
  "/rename": "name the current session",
  "/context": "token usage + cost",
  "/provider": "show or switch provider",
  "/mcp": "MCP servers and tools",
  "/plan": "toggle read-only plan mode",
  "/cost": "session token usage + cost",
  "/config": "show the resolved configuration",
  "/doctor": "diagnose setup (provider, key, git, env)",
  "/diff": "show the working-tree git diff",
  "/commit": "stage all changes and commit (/commit <message>)",
  "/commit-push-pr": "commit, push, and open a PR (/commit-push-pr <title>)",
  "/branch": "list branches, or switch/create (/branch [name])",
  "/issue": "list open issues, or open one (/issue [title])",
  "/pr-comments": "show review comments on the current PR",
  "/review": "review your working-tree changes for bugs",
  "/security-review": "audit your working-tree changes for security issues",
  "/autofix-pr": "address the open PR's review comments and CI failures",
  "/explore": "dispatch a read-only explore sub-agent (/explore <task>)",
  "/agents": "list available sub-agent types",
  "/skills": "list available project skills",
  "/workflows": "list or run a multi-agent workflow (/workflows [name] [input])",
  "/ultraplan": "freecode composes a multi-agent workflow for a task and runs it (/ultraplan <task>)",
  "/bg": "run a prompt as a detached background job, or list jobs (/bg [prompt])",
  "/learn": "self-improvement: propose (/learn), save (/learn save <n|all>), score (/learn stats), prune",
  "/plugins": "list/install/uninstall/enable/disable plugins (/plugins install <git-url|path>)",
  "/verify": "run the project's checks",
  "/bench": "race the performance ghost",
  "/log": "toggle the verification activity log",
  "/help": "list commands",
  "/compact": "compact the conversation",
  "/about": "meet Bubo, the freecode owl",
  "/exit": "exit freecode",
};

const PLAN_MODE_NOTE =
  "\n\nPLAN MODE: You are in read-only planning mode. Do NOT modify anything — no file writes or edits, no state-changing commands. Investigate the request using the available read-only tools, then present a concise, numbered implementation plan and STOP. The user will review it and exit plan mode to have you carry it out.";

// 5-row block font for the startup banner.
const FONT: Record<string, string[]> = {
  F: ["█████", "█    ", "████ ", "█    ", "█    "],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  " ": ["     ", "     ", "     ", "     ", "     "],
};

function bannerRows(word: string): string[] {
  const rows = ["", "", "", "", ""];
  for (const ch of word.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT[" "]!;
    for (let i = 0; i < 5; i++) rows[i] += glyph[i] + "  ";
  }
  return rows;
}

// Interpolate an azure→deep-blue gradient across the banner rows.
function gradientHex(t: number): string {
  const top = { r: 124, g: 192, b: 255 };
  const bot = { r: 45, g: 90, b: 168 };
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  const c = [lerp(top.r, bot.r), lerp(top.g, bot.g), lerp(top.b, bot.b)];
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function defaultEndpoint(provider: string, baseUrl?: string): string {
  if (baseUrl) return baseUrl;
  switch (provider) {
    case "openai": return "https://api.openai.com/v1";
    case "github-models": return "https://models.inference.ai.azure.com";
    case "gemini": return "https://generativelanguage.googleapis.com";
    case "anthropic": return "https://api.anthropic.com";
    case "ollama": return "http://localhost:11434/v1";
    case "lmstudio": return "http://127.0.0.1:1234/v1";
    case "nim": return "https://integrate.api.nvidia.com/v1";
    case "openrouter": return "https://openrouter.ai/api/v1";
    default: return "(default)";
  }
}

function Banner(): JSX.Element {
  const rows = [...bannerRows("FREE"), ...bannerRows("CODE")];
  return (
    <Box flexDirection="column" marginLeft={1}>
      {rows.map((row, i) => (
        <Text key={i} color={gradientHex(i / (rows.length - 1))} bold>
          {row}
        </Text>
      ))}
    </Box>
  );
}

// Human-readable reason a provider was selected — shown in the startup box so
// "why is it on X?" is never a mystery.
function providerReason(provider: string, source: string): string {
  switch (source) {
    case "cli": return "--provider flag";
    case "profile": return ".freecode-profile.json";
    case "env": {
      const flag = `CLAUDE_CODE_USE_${provider.toUpperCase().replace(/-/g, "_")}`;
      if (process.env[flag]) return flag;
      const keyVar: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY",
        "github-models": "GITHUB_TOKEN", nim: "NVIDIA_API_KEY", ollama: "OLLAMA_HOST", lmstudio: "LMSTUDIO_HOST",
      };
      return keyVar[provider] && process.env[keyVar[provider]!] ? keyVar[provider]! : "env";
    }
    case "default": return "auto-detected key";
    default: return source;
  }
}

// Earned-confidence badge for the footer. Reflects the verification state of the
// CURRENT code (not the last action, not a tally): have the project's checks
// passed with nothing changed since? Derived only from real verify/ledger
// signals (see ../tui/confidence) — never a synthesized score.
function ConfidenceBadge({ state, theme }: { state: Confidence; theme: ReturnType<typeof makeTheme> }): JSX.Element {
  switch (state) {
    case "verified": return <Text color={theme.hex.success}>✓ verified</Text>;
    case "unverified": return <Text color={theme.hex.warning}>~ unverified</Text>;
    case "failing": return <Text color={theme.hex.error}>✗ failing</Text>;
    default: return <Text dimColor>· unchecked</Text>;
  }
}

interface IntroProps {
  provider: string;
  model: string;
  endpoint: string;
  isLocal: boolean;
  providerNote: string;
  hasKey: boolean;
  theme: ReturnType<typeof makeTheme>;
  blink?: boolean;
}

function Intro({ provider, model, endpoint, isLocal, providerNote, hasKey, theme, blink = false }: IntroProps): JSX.Element {
  const label = (s: string) => <Text color={theme.dim}>{s.padEnd(10)}</Text>;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" marginLeft={1}>
        <Mascot theme={theme} blink={blink} />
        <Box flexDirection="column" justifyContent="center" marginLeft={3}>
          <Banner />
          <Box marginTop={1}>
            <Text color={theme.hex.assistant}>✦ </Text>
            <Text>Total freedom. No guesswork.</Text>
            <Text color={theme.hex.assistant}> ✦</Text>
          </Box>
        </Box>
      </Box>
      <Box marginLeft={1} marginTop={1} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text>
          {label("Provider")}
          <Text color={theme.hex.assistant}>{provider}</Text>
          <Text color={theme.dim}>{`  · ${providerNote}`}</Text>
          {!hasKey && !isLocal && <Text color={theme.hex.warning}>{"  · no key — freecode auth add " + provider}</Text>}
        </Text>
        <Text>{label("Model")}<Text bold>{model}</Text></Text>
        <Text>{label("Endpoint")}<Text color={theme.user}>{endpoint}</Text></Text>
      </Box>
      <Box marginLeft={1}>
        <Text color={theme.hex.success}>● </Text>
        <Text color={theme.dim}>{(isLocal ? "local" : "remote").padEnd(8)}</Text>
        <Text color={theme.dim}>Ready — type </Text>
        <Text color={theme.hex.assistant}>/help</Text>
        <Text color={theme.dim}> to begin</Text>
      </Box>
      <Box marginLeft={1} marginTop={1}>
        <Text color={theme.dim}>freecode </Text>
        <Text color={theme.hex.assistant}>v0.1.0</Text>
      </Box>
    </Box>
  );
}

// One transcript line. Shared between the Static scrollback (settled turns)
// and the live region (the turn in flight) so both render identically.
function MessageLine({ m, theme }: { m: UiMessage; theme: ReturnType<typeof makeTheme> }): JSX.Element {
  // Assistant output gets markdown-aware rendering: fenced code blocks are
  // syntax-highlighted and inline `code` is coloured (instead of flat white).
  if (m.role === "assistant") {
    return <MarkdownBody text={m.text} theme={theme} marker={<Text color={theme.hex.assistant}>● </Text>} />;
  }
  return (
    <Text>
      {m.role === "user" && <Text color={theme.user}>› </Text>}
      {m.role === "tool" && <Text color={theme.tool}>⚙ </Text>}
      {m.role === "system" && <Text color={theme.dim}>· </Text>}
      <Text color={m.role === "ledger" ? theme.dim : undefined} dimColor={m.role === "ledger"}>{m.text}</Text>
    </Text>
  );
}

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  let config = loadConfig({ flags: opts.flags ?? {} });

  // First-run onboarding: no key anywhere for a cloud provider → collect them.
  const localProvider = ["ollama", "lmstudio", "mock"].includes(config.provider);
  if (!Vault.exists() && !config.apiKey && !localProvider && !opts.resumeId) {
    const { runOnboarding } = await import("./onboarding");
    await runOnboarding();
    config = loadConfig({ flags: opts.flags ?? {} }); // re-resolve now that the vault may hold keys
  }

  const { McpManager } = await import("../mcp/manager");
  const mcp = new McpManager();
  await mcp.startAll(config.mcpServers);

  const { render } = await import("ink");
  const instance = render(
    <Repl
      flags={opts.flags ?? {}}
      resumeId={opts.resumeId}
      initialPrompt={opts.initialPrompt}
      extraTools={mcp.tools}
      mcpStatus={mcp.status}
    />,
  );
  try {
    await instance.waitUntilExit();
  } finally {
    await mcp.stopAll();
    // Force a clean exit: lingering handles (a still-running spawned process's
    // pipes, raw-mode stdin) can otherwise keep the runtime alive after the UI
    // has closed, so the process appears to hang.
    process.exit(0);
  }
}

export function Repl({ flags, resumeId, initialPrompt, extraTools, mcpStatus }: ReplOptions): JSX.Element {
  const { exit } = useApp();
  // Config is stateful so /provider can switch the active provider live
  // (re-resolving that provider's key/baseUrl/model from the vault + settings).
  const [config, setConfig] = useState(() => loadConfig({ flags: flags ?? {} }));
  const theme = useMemo(() => makeTheme(config.theme), [config.theme]);
  const provider = useMemo(() => buildProvider(config), [config]);
  const tools = useMemo(
    () => [
      ...buildToolRegistry({
        webSearch: {
          tavilyKey: process.env.TAVILY_API_KEY,
          exaKey: process.env.EXA_API_KEY,
          firecrawlKey: process.env.FIRECRAWL_API_KEY,
          defaultBackend: config.webSearchProvider,
        },
      }),
      ...(extraTools ?? []),
    ],
    [config.webSearchProvider, extraTools],
  );
  const permission = useMemo(
    () => createPermissionEngine(config.permissionMode, (async () => "allow") as ApprovalCallback),
    [config.permissionMode],
  );
  const trackerRef = useRef(
    new ContextTracker({
      threshold: config.contextThreshold,
      windowSize: contextWindowFor(config.model),
      pricing: priceFor(config.model, config.provider),
    }),
  );
  const sessionRef = useRef<Session>(undefined as unknown as Session);
  const conversationRef = useRef<ChatMessage[]>([]); // running provider-format history

  const customCommands = useMemo(() => loadCustomCommands(process.cwd()), []);
  const slashNames = useMemo(
    () => [...SLASH_COMMANDS, ...[...customCommands.keys()].map((n) => `/${n}`)],
    [customCommands],
  );

  const [messages, setMessages] = useState<UiMessage[]>([]);
  // How many leading messages are "settled" (turn finished, no longer changing)
  // and so can live in <Static> — written to terminal scrollback once and never
  // re-rendered. Only the in-flight turn stays in the dynamic region, which
  // keeps the input box anchored instead of hopping as content grows.
  const [settled, setSettled] = useState(0);
  const [model, setModel] = useState(config.model);
  const [planMode, setPlanMode] = useState(false);
  const [menuIdx, setMenuIdx] = useState(0);
  // Text + caret kept in ONE state so fast input (e.g. paste) updates them
  // atomically — separate states race and garble characters.
  const [editor, setEditor] = useState<{ text: string; cursor: number }>({ text: "", cursor: 0 });
  const input = editor.text;
  const cursor = editor.cursor;
  // Live slash-command suggestions: shown while typing a command name (no space yet).
  const menuMatches = useMemo(
    () => matchCommands(input, slashNames).map((n) => ({ name: n, desc: COMMAND_DESC[n] ?? customCommands.get(n.slice(1))?.description ?? "" })),
    [input, slashNames, customCommands],
  );
  useEffect(() => { setMenuIdx(0); }, [input]); // reset highlight as the query changes
  // Guard against duplicate Enter events before React clears the input. On Windows,
  // a single physical Enter can emit \r + \n as two separate stdin events; both
  // arrive while the closure still sees the previous `input`, so without the guard
  // the same command runs twice (or more). The ref resets automatically once React
  // commits the cleared input (the `[input]` effect above).
  const submitGuard = useRef(false);
  useEffect(() => { submitGuard.current = false; }, [input]);
  const historyRef = useRef<string[]>([]); // submitted prompts, oldest first
  const [historyIdx, setHistoryIdx] = useState<number | null>(null); // null = editing live input
  const draftRef = useRef(""); // live input saved while browsing history
  const [busy, setBusy] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const [ctxFill, setCtxFill] = useState(0); // 0..1 — how full the context window is
  const [ctxTokens, setCtxTokens] = useState(0); // tokens currently in context
  const [confidence, setConfidence] = useState<Confidence>("unchecked");
  const [tick, setTick] = useState(0); // drives the spinner + Bubo's eyes while working
  const busyStartRef = useRef(0);
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  // Interactive resume picker: when open, ↑/↓ choose and Enter resumes.
  const [picker, setPicker] = useState<{ items: SessionMeta[]; idx: number } | null>(null);
  // Interactive model picker: when open, ↑/↓ choose and Enter switches.
  const [modelPicker, setModelPicker] = useState<{ items: string[]; idx: number } | null>(null);
  // Self-improvement: proposals from the last /learn, awaiting /learn save <n|all>.
  const learnProposalsRef = useRef<Proposal[]>([]);
  // Approval prompts are QUEUED, not held in a single slot. Parallel sub-agents
  // (a workflow fan-out) can each need approval at the same instant; a lone
  // resolver let the second prompt clobber the first, orphaning its promise so
  // the stage's Promise.all waited forever (the /ultraplan "hang"). The queue
  // serialises them: one shows at a time (driving `pending`), the rest wait.
  const approvalQueue = useRef(createApprovalQueue(setPending)).current;
  const abortRef = useRef<AbortController | null>(null);
  const streamIdRef = useRef<string | null>(null); // id of the assistant bubble currently streaming

  // Exit cleanly: abort any in-flight turn first so spawned tool processes (e.g.
  // a running test suite) are signaled to die — otherwise their open pipes keep
  // the runtime alive and the process appears to hang after the UI closes.
  const exitNow = (): void => {
    abortRef.current?.abort();
    approvalQueue.flush(); // unblock any sub-agents parked on a prompt so the process can die
    exit();
  };

  // When the app is idle (no turn running, no approval pending), every message
  // is final — flush them all to <Static>. During a turn `settled` is frozen,
  // so the streaming lines render in the dynamic region and the input holds.
  useEffect(() => {
    if (!busy && !pending) setSettled(messages.length);
  }, [busy, pending, messages.length]);

  // Honor reduced-motion: FREECODE_NO_ANIMATION / NO_ANIMATION → static indicators
  // instead of the spinner/eye animation (the CLI analog of prefersReducedMotion).
  const reducedMotion = process.env.FREECODE_NO_ANIMATION === "1" || process.env.NO_ANIMATION === "1";

  // Startup splash: <Static> can't animate (it writes once), so Bubo blinks in the
  // dynamic region for a beat at launch, then `introReady` flips and the frozen
  // half-size intro is committed to scrollback. Reduced motion skips straight to it.
  const [introReady, setIntroReady] = useState(false);
  const [eyeTick, setEyeTick] = useState(0);
  useEffect(() => {
    if (reducedMotion) { setIntroReady(true); return; }
    const blinkId = setInterval(() => setEyeTick((t) => t + 1), 240);
    const settle = setTimeout(() => { clearInterval(blinkId); setIntroReady(true); }, 2400);
    return () => { clearInterval(blinkId); clearTimeout(settle); };
  }, [reducedMotion]);
  const introBlink = !introReady && eyeTick % 5 === 4; // a quick blink ~once/1.2s during the splash

  // One clock while a turn runs: ticks the spinner (~90ms) and, every few ticks,
  // Bubo's eyes; also marks the start so we can show elapsed time. Skipped under
  // reduced motion (we still mark the start for the elapsed counter).
  useEffect(() => {
    if (!busy) { setTick(0); return; }
    busyStartRef.current = Date.now();
    if (reducedMotion) return;
    const id = setInterval(() => setTick((t) => t + 1), 90);
    return () => clearInterval(id);
  }, [busy, reducedMotion]);

  // Record session context once (no-op unless the activity log is enabled).
  useEffect(() => {
    logActivity(`SESSION start cwd=${process.cwd()} provider=${config.provider} model=${config.model} verifyMode=${config.verifyMode}`);
  }, []);

  // Update the confidence badge and log the transition to the activity log.
  const updateConfidence = (compute: (c: Confidence) => Confidence): void => {
    setConfidence((prev) => {
      const next = compute(prev);
      if (next !== prev) logActivity(`CONFIDENCE ${prev} → ${next}`);
      return next;
    });
  };

  // Restore a session into the live REPL — shared by /resume <id> and the picker.
  function doResume(s: Session): void {
    sessionRef.current = s;
    const events = readSession(s) as Array<{ kind: string; text: string; name?: string; ok?: boolean }>;
    const restored: UiMessage[] = events
      .filter((e) => e.kind === "user" || e.kind === "assistant" || e.kind === "tool_result")
      .map((e, i) => ({
        id: `${s.id}-${i}`,
        role: e.kind === "user" ? "user" : e.kind === "assistant" ? "assistant" : "tool",
        text: e.text,
        toolName: (e as { name?: string }).name,
        ok: (e as { ok?: boolean }).ok,
      }));
    conversationRef.current = historyFromEvents(events);
    setMessages([...restored, { id: `s-${Date.now()}`, role: "system", text: `Resumed (${conversationRef.current.length} messages of context)` }]);
  }

  const promptUser: ApprovalCallback = (req) => approvalQueue.enqueue(req);

  useEffect(() => {
    const cwd = process.cwd();
    if (resumeId) {
      const s = resumeSession(cwd, resumeId);
      if (!s) {
        setErrorLine(`No such session: ${resumeId}`);
        sessionRef.current = newSession(cwd);
      } else {
        sessionRef.current = s;
        const events = readSession(s) as Array<{ kind: string; text: string; name?: string; ok?: boolean }>;
        const restored: UiMessage[] = events
          .filter((e) => e.kind === "user" || e.kind === "assistant" || e.kind === "tool_result")
          .map((e, i) => ({
            id: `${s.id}-${i}`,
            role: e.kind === "user" ? "user" : e.kind === "assistant" ? "assistant" : "tool",
            text: e.text,
            toolName: (e as { name?: string }).name,
            ok: (e as { ok?: boolean }).ok,
          }));
        setMessages(restored);
        conversationRef.current = historyFromEvents(events);
      }
    } else {
      sessionRef.current = newSession(cwd);
    }
    if (mcpStatus && mcpStatus.length > 0) {
      const ok = mcpStatus.filter((s) => s.ok);
      const toolCount = ok.reduce((n, s) => n + s.toolCount, 0);
      const failed = mcpStatus.filter((s) => !s.ok);
      let text = `MCP: ${ok.length}/${mcpStatus.length} server(s) connected, ${toolCount} tool(s) available`;
      if (failed.length) text += ` — failed: ${failed.map((s) => `${s.name} (${s.error})`).join("; ")}`;
      setMessages((prev) => [...prev, { id: "mcp-init", role: "system", text }]);
    }
    if (initialPrompt) {
      void submit(initialPrompt);
    }
  }, []);

  async function submit(prompt: string): Promise<void> {
    if (!prompt.trim() || busy) return;
    logActivity(`USER ${prompt.replace(/\s+/g, " ").trim().slice(0, 200)}`);
    setBusy(true);
    setErrorLine(null);
    const { images, files, notes } = extractAttachments(prompt, process.cwd());
    const failed = notes.filter((n) => !n.startsWith("attached ") && !n.startsWith("included "));
    // Inline attached text files into the prompt the model receives (display stays clean).
    const effectivePrompt = files.length
      ? prompt + "\n\n" + files.map((f) => `Contents of ${f.path}:\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
      : prompt;
    const attachSuffix = [images.length ? `${images.length} image(s)` : "", files.length ? `${files.length} file(s)` : ""].filter(Boolean).join(", ");
    const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setMessages((prev) => [...prev, { id, role: "user", text: prompt + (attachSuffix ? `  [${attachSuffix} attached]` : "") }]);
    if (failed.length) setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: failed.join("\n") }]);
    appendEvent(sessionRef.current, { kind: "user", text: prompt, ts: new Date().toISOString() });
    let buffer = "";
    let streamedAny = false;
    const t0 = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;
    streamIdRef.current = null;
    try {
      // Plan mode: read-only tools (permission=safe) + a plan-only system prompt.
      const baseTools = planMode ? tools.filter((t) => t.permission === "safe") : tools;
      // Sub-agents (Tier A): offer the Agent tool outside plan mode. The getter
      // reads the live provider/model so a mid-session switch is honoured; the
      // sub-agent's toolset is baseTools (no Agent) — recursion-safe by design.
      const activeTools = planMode
        ? baseTools
        : [...baseTools, createAgentTool(() => ({
            provider, model, tools: baseTools, permission, promptUser,
            hooks: config.hooks, contextWindow: contextWindowFor(model),
            // Live sub-agent progress: render each interior tool call as a dim,
            // indented line so a long sub-agent run visibly moves (no frozen
            // spinner until the final report).
            onProgress: (line: string) => {
              streamIdRef.current = null; // the next assistant text starts a fresh bubble
              setMessages((prev) => [...prev, { id: `sap-${Date.now()}-${prev.length}`, role: "system", text: `     ${line}` }]);
            },
          }))];
      const systemPrompt = planMode ? toolListToSystemPrompt(activeTools) + PLAN_MODE_NOTE : undefined;
      // Auto-verify gate: skip in plan mode (nothing changes). on = quick checks; strict = full.
      const vmode = planMode ? "off" : config.verifyMode;
      const verifyPlan = vmode === "strict" ? resolveVerify(process.cwd(), config.verify)
        : vmode === "on" ? resolveQuickVerify(process.cwd())
        : undefined;
      const result = await runAgentLoop({
        provider,
        tools: activeTools,
        systemPrompt,
        model,
        maxTurns: config.maxTurns,
        prompt: effectivePrompt,
        images,
        history: conversationRef.current,
        contextWindow: contextWindowFor(model),
        contextThreshold: config.contextThreshold,
        enablePromptCache: config.enablePromptCache,
        enableExtendedThinking: config.enableExtendedThinking,
        hooks: config.hooks,
        verifyPlan,
        verifyMode: vmode,
        permission,
        promptUser,
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "text_delta" && e.text) {
            buffer += e.text;
            streamedAny = true;
            const delta = e.text;
            setMessages((prev) => {
              const sid = streamIdRef.current;
              if (sid) {
                return prev.map((m) => (m.id === sid ? { ...m, text: m.text + delta } : m));
              }
              const id = `a-${t0}-${prev.length}`;
              streamIdRef.current = id;
              return [...prev, { id, role: "assistant", text: delta }];
            });
          } else if (e.type === "tool_call" && e.call) {
            streamIdRef.current = null; // text after a tool call starts a fresh bubble
            const call = e.call;
            const tid = `t-${call.id ?? Math.random().toString(36).slice(2, 8)}`;
            setMessages((prev) => [...prev, { id: tid, role: "tool", text: `→ ${call.name}(${JSON.stringify(call.arguments).slice(0, 120)})`, toolName: call.name }]);
            appendEvent(sessionRef.current, { kind: "tool_call", id: call.id ?? tid, name: call.name, args: call.arguments, ts: new Date().toISOString() });
          } else if (e.type === "tool_result" && e.result) {
            const r = e.result;
            const rid = r.id ?? Math.random().toString(36).slice(2, 8);
            const tid = `r-${rid}`;
            setMessages((prev) =>
              prev
                .map((m) => (m.id === `t-${rid}` ? { ...m, text: m.text + (r.ok ? " ✓" : " ✗") } : m))
                .concat([{ id: tid, role: "tool", text: previewToolResult(r.output), toolName: "result", ok: r.ok }]),
            );
            appendEvent(sessionRef.current, { kind: "tool_result", id: rid, output: r.output, ok: r.ok, durationMs: r.durationMs, ts: new Date().toISOString() });
          } else if (e.type === "usage" && e.usage) {
            trackerRef.current.record(e.usage);
            setCostUsd(trackerRef.current.costUsd());
            setCtxFill(trackerRef.current.contextFill());
            setCtxTokens(trackerRef.current.contextTokens());
          } else if (e.type === "compacted" && e.text) {
            setCtxFill(trackerRef.current.contextFill());
            setCtxTokens(trackerRef.current.contextTokens());
            setMessages((prev) => [...prev, { id: `c-${Date.now()}`, role: "system", text: e.text! }]);
          } else if (e.type === "verify" && e.text) {
            if (/✓ Verified|passed/.test(e.text)) updateConfidence(() => "verified");
            else if (/failed|still failing/i.test(e.text)) updateConfidence(() => "failing");
            setMessages((prev) => [...prev, { id: `vfy-${Date.now()}-${prev.length}`, role: "system", text: e.text! }]);
          } else if (e.type === "ledger" && e.ledger) {
            const L = e.ledger;
            // Drive the confidence badge from the real ledger (sticky on read-only turns).
            updateConfidence((c) => nextConfidence(c, L));
            const lines: string[] = [];
            if (L.verified.length) lines.push(`✓ verified  ${L.verified.join("; ")}`);
            if (L.observed.length) lines.push(`· observed  ${L.observed.join("; ")}`);
            if (L.believed.length) lines.push(`~ believed  ${L.believed.join("; ")}`);
            if (lines.length) setMessages((prev) => [...prev, { id: `led-${Date.now()}-${prev.length}`, role: "ledger", text: lines.join("\n") }]);
          } else if (e.type === "error" && e.error) {
            setErrorLine(e.error);
          }
        },
      });
      conversationRef.current = result.messages; // carry full context into the next turn
      // Text was streamed live into assistant bubbles; only push a fallback
      // message if the provider produced text without streaming events.
      if (!streamedAny && buffer) {
        setMessages((prev) => [...prev, { id: `a-${t0}`, role: "assistant", text: buffer }]);
      }
      appendEvent(sessionRef.current, { kind: "assistant", text: buffer, ts: new Date().toISOString(), usage: result.usage as unknown as Record<string, number> });
      debug.log("turn complete", { turns: result.turns, usage: result.usage });
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages((prev) => [...prev, { id: `int-${Date.now()}`, role: "system", text: "⏹ Interrupted." }]);
      } else {
        setErrorLine(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function runSlash(cmd: string): Promise<void> {
    const [name, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(" ");
    switch (name) {
      case "/models": // alias
      case "/model": {
        if (arg) {
          setModel(arg);
          trackerRef.current.setPricing(priceFor(arg, config.provider));
          trackerRef.current.setWindow(contextWindowFor(arg));
          setCtxFill(trackerRef.current.contextFill());
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Model switched to ${arg} (provider: ${config.provider}). Active from your next message.` }]);
        } else {
          // No arg: open the interactive arrow-key picker (↑/↓ select, Enter
          // switch). `/model <name>` above still switches directly.
          setBusy(true);
          try {
            const all = await provider.models();
            const { show } = filterChatModels(all);
            const list = show.length ? show : all;
            if (!list.length) {
              setErrorLine("Provider returned no models.");
            } else {
              const cur = list.indexOf(model);
              setModelPicker({ items: list, idx: cur >= 0 ? cur : 0 });
            }
          } catch (err) {
            setErrorLine(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }
        break;
      }
      case "/new": {
        const cwd = process.cwd();
        sessionRef.current = newSession(cwd);
        conversationRef.current = [];
        setMessages([]);
        setCostUsd(0);
        setCtxFill(0);
        setCtxTokens(0);
        updateConfidence(() => "unchecked");
        setErrorLine(null);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "New session started" }]);
        break;
      }
      case "/resume": {
        if (!arg) {
          const metas = listSessionMetas(process.cwd()).slice(0, 12);
          if (!metas.length) {
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "No saved sessions yet." }]);
          } else {
            setPicker({ items: metas, idx: 0 });
          }
        } else {
          // resume by id, or by (case-insensitive) title match
          const metas = listSessionMetas(process.cwd());
          const byTitle = metas.find((m) => (m.title ?? "").toLowerCase() === arg.toLowerCase());
          const s = byTitle ? resumeSession(process.cwd(), byTitle.id) : resumeSession(process.cwd(), arg);
          if (s) doResume(s);
          else setErrorLine(`No such session: ${arg}`);
        }
        break;
      }
      case "/rename": {
        if (!arg.trim()) {
          setErrorLine("Usage: /rename <name>");
        } else {
          setSessionTitle(sessionRef.current, arg.trim());
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Renamed session to "${arg.trim()}"` }]);
        }
        break;
      }
      case "/context": {
        const u = trackerRef.current["usage"];
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Tokens: in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} thinking=${u.thinking}\nCost: $${costUsd.toFixed(4)}` }]);
        break;
      }
      case "/cost": {
        const u = trackerRef.current["usage"];
        const tot = u.input + u.output + u.cacheRead + u.cacheWrite;
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Session cost: $${costUsd.toFixed(4)}  (${model} · ${config.provider})\nTokens: ${tot} total — in ${u.input}, out ${u.output}, cache ${u.cacheRead}r/${u.cacheWrite}w, thinking ${u.thinking}` }]);
        break;
      }
      case "/config": {
        const lines = [
          `provider     ${config.provider}`,
          `model        ${model}`,
          `endpoint     ${defaultEndpoint(config.provider, config.baseUrl)}`,
          `key          ${config.apiKey ? "set" : "none"}`,
          `permission   ${config.permissionMode}`,
          `verifyMode   ${config.verifyMode}`,
          `theme        ${config.theme}`,
          `maxTurns     ${config.maxTurns}`,
          `maxRPM       ${config.maxRequestsPerMinute > 0 ? config.maxRequestsPerMinute : "off"}`,
          `webSearch    ${config.webSearchProvider}`,
          `promptCache  ${config.enablePromptCache}`,
        ];
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: lines.join("\n") }]);
        break;
      }
      case "/doctor": {
        const { execSync } = await import("node:child_process");
        const tryExec = (cmd: string): string | null => { try { return execSync(cmd, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
        const local = ["ollama", "lmstudio", "mock"].includes(config.provider);
        const lines = [
          "freecode doctor",
          `  cwd          ${process.cwd()}`,
          `  git          ${tryExec("git rev-parse --is-inside-work-tree") === "true" ? "repo ✓" : "not a git repo"}`,
          `  provider     ${config.provider}`,
          `  key          ${config.apiKey ? "set ✓" : local ? "n/a (local)" : "MISSING ✗ — freecode auth add " + config.provider}`,
          `  model        ${model}`,
          `  runtime      bun ${(globalThis as { Bun?: { version?: string } }).Bun?.version ?? "?"}`,
          `  verifyMode   ${config.verifyMode}`,
        ];
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: lines.join("\n") }]);
        break;
      }
      case "/diff": {
        const { execSync } = await import("node:child_process");
        try {
          const stat = execSync("git diff --stat", { cwd: process.cwd(), encoding: "utf8" }).trim();
          if (!stat) { setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "No unstaged changes." }]); break; }
          const diff = execSync("git diff", { cwd: process.cwd(), encoding: "utf8" });
          const body = diff.length > 6000 ? diff.slice(0, 6000) + "\n… (diff truncated)" : diff;
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `${stat}\n\n${body}` }]);
        } catch (err) {
          setErrorLine(`git diff failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "/commit": {
        const { execSync } = await import("node:child_process");
        try {
          const status = execSync("git status --short", { cwd: process.cwd(), encoding: "utf8" }).trim();
          if (!status) { setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Nothing to commit — working tree clean." }]); break; }
          if (!arg.trim()) { setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Changes to commit:\n${status}\n\nUsage: /commit <message>` }]); break; }
          execSync("git add -A", { cwd: process.cwd() });
          // -F - reads the message from stdin, avoiding any shell-quoting issues.
          execSync("git commit -F -", { cwd: process.cwd(), input: arg.trim() });
          const head = execSync("git log -1 --oneline", { cwd: process.cwd(), encoding: "utf8" }).trim();
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `✓ Committed: ${head}` }]);
        } catch (err) {
          setErrorLine(`commit failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "/review": {
        // Hand the working-tree changes to the agent for a focused review,
        // through the normal loop (it has the provider + Bash to read the diff).
        void submit(
          "Review my current working-tree changes for a code review. Run `git diff` (and `git diff --staged`) to see them, then report correctness bugs, risky edits, and concrete improvements — concise, specific, cite file:line. If there are no changes, say so plainly." +
          (arg.trim() ? `\n\nFocus: ${arg.trim()}` : ""),
        );
        break;
      }
      case "/branch": {
        const r = gitBranch(process.cwd(), arg.trim() || undefined);
        if (r.ok) setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: r.text }]);
        else setErrorLine(r.text);
        break;
      }
      case "/commit-push-pr": {
        if (!arg.trim()) { setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Usage: /commit-push-pr <title>" }]); break; }
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Committing, pushing, and opening a PR…" }]);
        const r = commitPushPr(process.cwd(), arg.trim());
        if (r.ok) setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: r.text }]);
        else setErrorLine(r.text);
        break;
      }
      case "/issue": {
        const r = ghIssue(process.cwd(), arg.trim() || undefined);
        if (r.ok) setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: r.text }]);
        else setErrorLine(r.text);
        break;
      }
      case "/pr-comments": {
        const r = prComments(process.cwd());
        if (r.ok) setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: r.text }]);
        else setErrorLine(r.text);
        break;
      }
      case "/security-review": {
        void submit(
          "Perform a SECURITY review of my current working-tree changes. Run `git diff` (and `git diff --staged`) to see them, then look specifically for: injection (shell/SQL/path), secret/credential exposure, missing authz/authn checks, unsafe deserialization, SSRF, path traversal, and unvalidated input reaching a sink. Report each finding with file:line, the concrete risk, and a fix. If the changes have no security-relevant surface, say so plainly." +
          (arg.trim() ? `\n\nFocus: ${arg.trim()}` : ""),
        );
        break;
      }
      case "/autofix-pr": {
        void submit(
          "Address the open pull request for the current branch. Use the `gh` CLI: run `gh pr view --comments` to read review comments and `gh pr checks` to find failing CI. Then make the concrete code changes needed to resolve the review comments and fix the failing checks, verifying as you go. If there is no open PR or `gh` is unavailable, say so plainly and stop." +
          (arg.trim() ? `\n\nFocus: ${arg.trim()}` : ""),
        );
        break;
      }
      case "/explore": {
        if (!arg.trim()) {
          setErrorLine("Usage: /explore <task>  — dispatches a read-only explore sub-agent (Glob, Grep, FileRead)");
          break;
        }
        void submit(`Use the Agent tool with subagent_type "explore" to: ${arg.trim()}. Return its findings verbatim.`);
        break;
      }
      case "/agents": {
        const types = resolveAgentTypes(process.cwd());
        const lines = types.map((t) =>
          `  ${t.name}${t.source !== "builtin" ? ` (${t.source})` : ""} — ${t.description}` +
          (t.tools ? `  [tools: ${t.tools.join(", ")}]` : ""),
        );
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
          `Sub-agent types (the Agent tool dispatches these):\n${lines.join("\n")}\n\n` +
          "Define your own in .freecode/agents/<name>.md — frontmatter `description:` and optional `tools:`, body is the agent's prompt." }]);
        break;
      }
      case "/skills": {
        const skills = resolveSkills(process.cwd());
        if (!skills.length) {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
            "No skills defined. Add one at .freecode/skills/<name>.md — frontmatter `description:` (the trigger), body is the instructions. The agent loads it on demand when a task matches." }]);
          break;
        }
        const lines = skills.map((s) => `  ${s.name} (${s.source}) — ${s.description}`);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
          `Skills (the agent loads these on demand via the Skill tool):\n${lines.join("\n")}` }]);
        break;
      }
      case "/learn": {
        const sub = arg.trim();
        // /learn stats — the scorecards: which learned artifacts earn their keep.
        if (sub === "stats" || sub === "score") {
          const stats = listStats(process.cwd());
          if (!stats.length) { setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "No learned artifacts yet. Teach freecode with /learn." }]); break; }
          const ageDays = (iso: string): number => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
          const lines = stats.map((s) => {
            const fired = s.fires > 0 ? `${s.fires}× (last ${s.lastFiredAt ? ageDays(s.lastFiredAt) + "d ago" : "?"})` : "never fired";
            return `  ${s.fires > 0 ? "✓" : "·"} [${s.kind}] ${s.name} — ${fired}, age ${ageDays(s.createdAt)}d`;
          });
          const decay = decayCandidates(stats, { asOf: Date.now() });
          let trendLine = "";
          try {
            const st = activityState();
            if (st.on) {
              const t = verifyTrend(readFileForLearn(st.path, "utf8"));
              const pct = (x: { sessions: number; passedFirst: number }) => (x.sessions ? Math.round((x.passedFirst / x.sessions) * 100) + "%" : "—");
              if (t.before.sessions || t.after.sessions) trendLine = `\n\nVerify-first-try (correlational): before teaching ${pct(t.before)} · since ${pct(t.after)}`;
            }
          } catch { /* no log */ }
          const decayLine = decay.length ? `\n\n${decay.length} never-fired artifact(s) old enough to prune: ${decay.map((d) => d.name).join(", ")} — /learn prune` : "";
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Learned-artifact scorecards:\n${lines.join("\n")}${trendLine}${decayLine}` }]);
          break;
        }
        // /learn prune — remove never-fired artifacts that are old enough to judge.
        if (sub === "prune") {
          const decay = decayCandidates(listStats(process.cwd()), { asOf: Date.now() });
          if (!decay.length) { setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Nothing to prune — every learned artifact has fired or is too new to judge." }]); break; }
          const done = decay.map((d) => {
            const r = pruneArtifact(process.cwd(), d);
            logActivity(`LEARN pruned ${d.kind} "${d.name}"`);
            return `  ✗ ${d.kind} ${d.name}${d.kind === "rule" ? " (scorecard dropped — remove its line from FREECODE.md by hand)" : r.removedFile ? " (skill file removed)" : ""}`;
          });
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Pruned ${decay.length} never-fired artifact(s):\n${done.join("\n")}` }]);
          break;
        }
        // /learn save <n|all> — apply previously-proposed artifacts.
        if (sub.startsWith("save")) {
          const pick = sub.slice(4).trim();
          const proposals = learnProposalsRef.current;
          if (!proposals.length) { setErrorLine("Nothing to save — run /learn first."); break; }
          const chosen = pick === "all"
            ? proposals.map((_, i) => i)
            : pick.split(/[\s,]+/).map((n) => Number(n) - 1).filter((i) => i >= 0 && i < proposals.length);
          if (!chosen.length) { setErrorLine("Usage: /learn save <n|all> (e.g. /learn save 1 3)"); break; }
          const done: string[] = [];
          for (const i of chosen) {
            try {
              const r = applyProposal(proposals[i]!, process.cwd());
              ensureStat(process.cwd(), proposals[i]!.kind, proposals[i]!.name, new Date().toISOString());
              done.push(`  ✓ ${proposals[i]!.kind} → ${r.path}`);
              logActivity(`LEARN saved ${proposals[i]!.kind} "${proposals[i]!.name}"`);
            } catch (err) {
              done.push(`  ✗ ${proposals[i]!.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
            `Saved:\n${done.join("\n")}\n\nActive next session (rules) / on demand (skills).` }]);
          break;
        }
        // /learn — analyze this session and propose durable improvements.
        const history = conversationRef.current;
        if (history.length < 2) { setErrorLine("Not enough conversation yet to learn from."); break; }
        setBusy(true);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "◓ Reviewing this session for durable improvements…" }]);
        try {
          const transcript = transcriptFromMessages(history);
          let activityTail: string | undefined;
          try {
            const st = activityState();
            if (st.on) activityTail = readFileForLearn(st.path, "utf8").split("\n").slice(-60).join("\n");
          } catch { /* no log — fine */ }
          const raw = await analyzeSession(provider, model, { transcript, activityTail });
          const existing = resolveSkills(process.cwd()).map((s) => s.name);
          const proposals = dedupeProposals(raw, existing);
          learnProposalsRef.current = proposals;
          if (!proposals.length) {
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Nothing worth saving from this session — no proposals. (That's a fine outcome.)" }]);
            break;
          }
          const blocks = proposals.map((p, i) =>
            `${i + 1}. [${p.kind}] ${p.name} — ${p.description}\n     ${p.body.replace(/\s+/g, " ").trim().slice(0, 160)}\n     evidence: ${p.evidence[0]?.slice(0, 100) ?? ""}`,
          );
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
            `freecode proposes ${proposals.length} improvement${proposals.length > 1 ? "s" : ""} (nothing is saved until you say so):\n\n${blocks.join("\n\n")}\n\nSave with /learn save <n|all> — e.g. /learn save 1` }]);
        } catch (err) {
          setErrorLine(`/learn failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setBusy(false);
        }
        break;
      }
      case "/plugin": // singular alias
      case "/plugins": {
        // Split off the first token as the subcommand; keep the REST intact so a
        // git URL or path (which never splits cleanly on spaces) survives whole.
        const trimmed = arg.trim();
        const sp = trimmed.search(/\s/);
        const sub = sp === -1 ? trimmed : trimmed.slice(0, sp);
        const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
        if (sub === "enable" || sub === "disable") {
          const name = rest.split(/\s+/)[0];
          if (!name) { setErrorLine(`Usage: /plugins ${sub} <name>`); break; }
          setPluginEnabled(name, sub === "enable");
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `${sub === "enable" ? "Enabled" : "Disabled"} plugin "${name}". Active from your next message (restart for plugin commands).` }]);
          break;
        }
        if (sub === "install") {
          if (!rest) { setErrorLine("Usage: /plugins install <git-url|local-path>"); break; }
          setBusy(true);
          try {
            const p = await installPlugin(rest, process.cwd());
            const contribs = (Object.keys(p.contributions) as Array<keyof typeof p.contributions>)
              .filter((k) => p.contributions[k].length)
              .map((k) => `  ${k}: ${p.contributions[k].join(", ")}`);
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
              `✓ Installed "${p.name}"${p.version ? ` v${p.version}` : ""}${p.description ? ` — ${p.description}` : ""}\n` +
              (contribs.length ? contribs.join("\n") + "\n" : "  (no commands/agents/skills/workflows found)\n") +
              "Active from your next message (restart for plugin commands)." }]);
          } catch (err) {
            setErrorLine(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
          break;
        }
        if (sub === "uninstall" || sub === "remove") {
          const name = rest.split(/\s+/)[0];
          if (!name) { setErrorLine("Usage: /plugins uninstall <name>"); break; }
          try {
            uninstallPlugin(name);
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Uninstalled "${name}".` }]);
          } catch (err) {
            setErrorLine(err instanceof Error ? err.message : String(err));
          }
          break;
        }
        const plugins = resolvePlugins(process.cwd());
        if (!plugins.length) {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
            "No plugins installed. Install one with /plugins install <git-url|path>, or drop a bundle at .freecode/plugins/<name>/ — a plugin.json plus any of commands/ agents/ skills/ workflows/." }]);
          break;
        }
        const lines = plugins.map((p) => `  ${p.enabled ? "●" : "○"} ${p.name}${p.version ? ` v${p.version}` : ""} (${p.source})${p.description ? ` — ${p.description}` : ""}`);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
          `Plugins (● enabled · ○ disabled):\n${lines.join("\n")}\n\ninstall <git-url|path> · uninstall <name> · enable|disable <name>.` }]);
        break;
      }
      case "/workflows": {
        const wfs = resolveWorkflows(process.cwd());
        const [name, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
        if (!name) {
          if (!wfs.length) {
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
              "No workflows defined. Add one at .freecode/workflows/<name>.json — `{ description, stages: [{ name, tasks: [{ agent, prompt }] }] }`. Tasks in a stage run in parallel; prompts can use {{input}} and {{previous}}." }]);
            break;
          }
          const lines = wfs.map((w) => `  ${w.name} (${w.source}) — ${w.description} [${w.stages.length} stage${w.stages.length > 1 ? "s" : ""}]`);
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
            `Workflows (run with /workflows <name> [input]):\n${lines.join("\n")}` }]);
          break;
        }
        const wf = getWorkflow(name, process.cwd());
        if (!wf) { setErrorLine(`Unknown workflow "${name}". Run /workflows to list them.`); break; }
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `▶ Running workflow "${wf.name}" (${wf.stages.length} stage${wf.stages.length > 1 ? "s" : ""})…` }]);
        try {
          const res = await runWorkflow(wf, {
            provider, model, tools, permission, promptUser,
            hooks: config.hooks, contextWindow: contextWindowFor(model),
            input: rest.join(" "), cwd: process.cwd(), signal: controller.signal,
            onEvent: (e) => {
              const line = workflowEventLine(e);
              if (line) setMessages((prev) => [...prev, { id: `wf-${Date.now()}-${prev.length}`, role: "system", text: line }]);
            },
          });
          setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", text: res.output || "(workflow produced no output)" }]);
        } catch (err) {
          setErrorLine(`workflow failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setBusy(false);
        }
        break;
      }
      case "/ultraplan": {
        const task = arg.trim();
        if (!task) {
          setErrorLine("Usage: /ultraplan <task> — freecode composes a multi-agent workflow for the task and runs it.");
          break;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "◓ Composing a workflow…" }]);
        try {
          const wf = await composeWorkflow(provider, model, task, process.cwd(), controller.signal);
          logActivity(`ULTRAPLAN composed ${wf.stages.length} stage(s), ${wf.stages.reduce((n, s) => n + s.tasks.length, 0)} task(s) for: ${task.slice(0, 80)}`);
          const plan = wf.stages
            .map((s, i) => `  ${i + 1}. ${s.name ?? `stage ${i + 1}`} — ${s.tasks.map((t) => t.agent ?? "general").join(" ∥ ")}`)
            .join("\n");
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
            `Plan: ${wf.description}\n${plan}\n▶ Running ${wf.stages.length} stage${wf.stages.length > 1 ? "s" : ""}… (esc to abort)` }]);
          const res = await runWorkflow(wf, {
            provider, model, tools, permission, promptUser,
            hooks: config.hooks, contextWindow: contextWindowFor(model),
            input: task, cwd: process.cwd(), signal: controller.signal,
            onEvent: (e) => {
              const line = workflowEventLine(e);
              if (line) setMessages((prev) => [...prev, { id: `wf-${Date.now()}-${prev.length}`, role: "system", text: line }]);
            },
          });
          const output = res.output || "(workflow produced no output)";
          setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", text: output }]);
          // Thread the result into the conversation so the user can follow up on it.
          conversationRef.current = [...conversationRef.current,
            { role: "user", content: `/ultraplan ${task}` },
            { role: "assistant", content: output }];
          appendEvent(sessionRef.current, { kind: "user", text: `/ultraplan ${task}`, ts: new Date().toISOString() });
          appendEvent(sessionRef.current, { kind: "assistant", text: output, ts: new Date().toISOString() });
        } catch (err) {
          if (controller.signal.aborted) setMessages((prev) => [...prev, { id: `int-${Date.now()}`, role: "system", text: "⏹ Aborted." }]);
          else setErrorLine(`ultraplan failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setBusy(false);
        }
        break;
      }
      case "/bg": {
        const task = arg.trim();
        if (task) {
          try {
            const job = startBackground(task, { provider: config.provider, model });
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
              `▷ Background job ${job.id} started (pid ${job.pid ?? "?"}). It runs detached — keep working.\n  /bg to list · freecode bg logs ${job.id} to follow.` }]);
          } catch (err) {
            setErrorLine(`Could not start background job: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        const jobs = reapJobs();
        if (!jobs.length) {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "No background jobs. Start one with /bg <prompt>." }]);
          break;
        }
        const running = jobs.filter((j) => j.status === "running").length;
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
          `Background jobs (${jobs.length}, ${running} running):\n${jobs.map((j) => `  ${formatJobLine(j)}`).join("\n")}` }]);
        break;
      }
      case "/provider": {
        const KNOWN = ["anthropic", "openai", "gemini", "github-models", "openrouter", "bedrock", "vertex", "ollama", "lmstudio", "nim", "mock"];
        if (arg) {
          if (!KNOWN.includes(arg)) {
            const suggestion = closest(arg, KNOWN, 4);
            setErrorLine(`Unknown provider: ${arg}${suggestion ? ` — did you mean ${suggestion}?` : ""}. Options: ${KNOWN.join(", ")}`);
            break;
          }
          // Re-resolve for the chosen provider — pulls its key/baseUrl/model from
          // the vault + settings — and switch live.
          const newCfg = loadConfig({ flags: { ...(flags ?? {}), provider: arg as CliFlags["provider"] } });
          setConfig(newCfg);
          setModel(newCfg.model);
          trackerRef.current.setPricing(priceFor(newCfg.model, newCfg.provider));
          trackerRef.current.setWindow(contextWindowFor(newCfg.model));
          setCtxFill(trackerRef.current.contextFill());
          const local = ["ollama", "lmstudio", "mock"].includes(newCfg.provider);
          const text = !newCfg.apiKey && !local
            ? `Switched to ${arg} (model ${newCfg.model}) — but no API key found. Add one with:  freecode auth add ${arg}`
            : `Switched to ${arg} — model ${newCfg.model}, ${defaultEndpoint(newCfg.provider, newCfg.baseUrl)}. Active from your next message.`;
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text }]);
        } else {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Provider: ${config.provider}\nModel: ${model}\nEndpoint: ${defaultEndpoint(config.provider, config.baseUrl)}\nKey: ${config.apiKey ? "set" : "none"}\n\nSwitch with /provider <name> (${KNOWN.join(", ")}).` }]);
        }
        break;
      }
      case "/verify": {
        const plan = resolveVerify(process.cwd(), config.verify);
        if (plan.source === "none") {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "No verification command found. Set \"verify\" in settings, or add a test/typecheck script." }]);
          break;
        }
        setBusy(true);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Verifying (${plan.source}): ${plan.commands.join(" && ")}…` }]);
        try {
          const res = await runVerify(plan, process.cwd());
          updateConfidence(() => (res.ok ? "verified" : "failing"));
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: res.ok
            ? `✓ Verified — ${res.ranCommands.join(" && ")} passed.`
            : `✗ Verification failed at \`${res.failedCommand}\`:\n${res.output.slice(-1500)}` }]);
        } catch (err) {
          setErrorLine(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
        break;
      }
      case "/plan": {
        const on = !planMode;
        setPlanMode(on);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: on
          ? "Plan mode ON — I'll investigate (read-only) and propose a plan without making changes. Run /plan again to exit and let me implement."
          : "Plan mode OFF — I can make changes again." }]);
        break;
      }
      case "/mcp": {
        if (!mcpStatus || mcpStatus.length === 0) {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "No MCP servers configured. Add them under \"mcpServers\" in ~/.freecode/settings.json." }]);
        } else {
          const lines = mcpStatus.map((s) =>
            s.ok ? `  ● ${s.name} — ${s.toolCount} tool(s)` : `  ✗ ${s.name} — ${s.error ?? "failed"}`,
          );
          const toolNames = (extraTools ?? []).map((t) => `    · ${t.name}`).join("\n");
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `MCP servers:\n${lines.join("\n")}${toolNames ? `\n  tools:\n${toolNames}` : ""}` }]);
        }
        break;
      }
      case "/help": {
        const custom = [...customCommands.values()].map((c) => `${`/${c.name}`}${c.description ? ` — ${c.description}` : ""} (${c.source})`);
        const text = SLASH_COMMANDS.join("\n") + (custom.length ? `\n\nCustom commands:\n${custom.join("\n")}` : "");
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text }]);
        break;
      }
      case "/about": {
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `${OWL_MICRO}  ${MASCOT_BIO}` }]);
        break;
      }
      case "/bench": {
        setBusy(true);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Racing the ghost…" }]);
        try {
          const run = await executeBench({});
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: formatBenchPlain(run) }]);
        } catch (err) {
          setErrorLine(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
        break;
      }
      case "/log": {
        const want = arg.trim().toLowerCase();
        const cur = activityState();
        const on = want === "on" ? true : want === "off" ? false : !cur.on;
        const st = setActivityLog(on);
        if (on) logActivity(`--- activity log enabled (cwd=${process.cwd()} provider=${config.provider} model=${model}) ---`);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: on
          ? `Activity log ON → ${st.path}\nRecords commands, verify runs, the ledger, and confidence transitions. Share that file to audit verification.`
          : "Activity log OFF." }]);
        break;
      }
      case "/exit":
      case "/quit": {
        exitNow();
        break;
      }
      case "/compact": {
        const msgs = conversationRef.current;
        if (msgs.length <= 3) {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Nothing to compact yet." }]);
          break;
        }
        setBusy(true);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "· Compacting context…" }]);
        try {
          const tracker = new ContextTracker({});
          const result = await tracker.compact(msgs, (m) => summarizeConversation(provider, model, m));
          if (result.removedCount > 0) {
            conversationRef.current = result.messages;
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Compacted ${result.removedCount} older messages into a summary (~${result.summaryTokens} tokens); ${result.messages.length} messages kept.` }]);
          } else {
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Not enough history to compact." }]);
          }
        } catch (err) {
          setErrorLine(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
        break;
      }
      default: {
        const custom = customCommands.get((name ?? "").replace(/^\//, ""));
        if (custom) {
          void submit(expandCommand(custom.body, arg));
        } else {
          const suggestion = closest(name ?? "", slashNames, 3);
          setErrorLine(`Unknown command: ${name}${suggestion ? ` — did you mean ${suggestion}?` : ""}`);
        }
      }
    }
  }

  useInput((input2, key) => {
    if (key.ctrl && input2 === "c") {
      exitNow();
      return;
    }
    // While the resume picker is open, ↑/↓ choose, Enter resumes, Esc cancels.
    if (picker) {
      if (key.upArrow) { setPicker((p) => (p ? { ...p, idx: Math.max(0, p.idx - 1) } : p)); return; }
      if (key.downArrow) { setPicker((p) => (p ? { ...p, idx: Math.min(p.items.length - 1, p.idx + 1) } : p)); return; }
      if (key.return) { const sel = picker.items[picker.idx]; setPicker(null); if (sel) doResume({ id: sel.id, cwd: sel.cwd, path: sel.path }); return; }
      if (key.escape) { setPicker(null); return; }
      return; // swallow everything else while picking
    }
    // While the model picker is open, ↑/↓ choose, Enter switches, Esc cancels.
    if (modelPicker) {
      if (key.upArrow) { setModelPicker((p) => (p ? { ...p, idx: Math.max(0, p.idx - 1) } : p)); return; }
      if (key.downArrow) { setModelPicker((p) => (p ? { ...p, idx: Math.min(p.items.length - 1, p.idx + 1) } : p)); return; }
      if (key.return) {
        const sel = modelPicker.items[modelPicker.idx];
        setModelPicker(null);
        if (sel) {
          setModel(sel);
          trackerRef.current.setPricing(priceFor(sel, config.provider));
          trackerRef.current.setWindow(contextWindowFor(sel));
          setCtxFill(trackerRef.current.contextFill());
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Model switched to ${sel} (provider: ${config.provider}). Active from your next message.` }]);
        }
        return;
      }
      if (key.escape) { setModelPicker(null); return; }
      return; // swallow everything else while picking
    }
    // While a tool-approval prompt is open, keys select a decision and nothing else.
    if (pending) {
      // esc = bail out: abort the run AND deny the whole queue, so a fan-out of
      // blocked sub-agents unwinds on a single keypress.
      if (key.escape) { abortRef.current?.abort(); approvalQueue.flush(); return; }
      const decision = approvalDecisionForKey(input2, false);
      if (decision) approvalQueue.resolveHead(decision);
      return;
    }
    // esc interrupts a running turn.
    if (key.escape && busy) {
      abortRef.current?.abort();
      return;
    }
    if (key.ctrl && input2 === "u") {
      setEditor({ text: "", cursor: 0 });
      return;
    }
    if (key.ctrl && input2 === "t") {
      setShowTasks((v) => !v);
      return;
    }
    if (key.ctrl && input2 === "a") { setEditor((e) => ({ ...e, cursor: 0 })); return; }            // line start
    if (key.ctrl && input2 === "e") { setEditor((e) => ({ ...e, cursor: e.text.length })); return; } // line end
    // When the slash-command menu is open, up/down navigate it (not history).
    if (menuMatches.length > 0 && key.upArrow) { setMenuIdx((i) => Math.max(0, i - 1)); return; }
    if (menuMatches.length > 0 && key.downArrow) { setMenuIdx((i) => Math.min(menuMatches.length - 1, i + 1)); return; }
    // Command history (up/down).
    if (key.upArrow) {
      const h = historyRef.current;
      if (h.length === 0) return;
      const idx = historyIdx === null ? h.length - 1 : Math.max(0, historyIdx - 1);
      if (historyIdx === null) draftRef.current = input;
      setHistoryIdx(idx);
      setEditor({ text: h[idx]!, cursor: h[idx]!.length });
      return;
    }
    if (key.downArrow) {
      if (historyIdx === null) return;
      const h = historyRef.current;
      if (historyIdx >= h.length - 1) {
        setHistoryIdx(null);
        setEditor({ text: draftRef.current, cursor: draftRef.current.length });
      } else {
        const idx = historyIdx + 1;
        setHistoryIdx(idx);
        setEditor({ text: h[idx]!, cursor: h[idx]!.length });
      }
      return;
    }
    if (key.leftArrow) { setEditor((e) => ({ ...e, cursor: Math.max(0, e.cursor - 1) })); return; }
    if (key.rightArrow) { setEditor((e) => ({ ...e, cursor: Math.min(e.text.length, e.cursor + 1) })); return; }
    if (key.tab) {
      if (menuMatches.length > 0) {
        // Complete the highlighted suggestion from the live menu.
        const pick = menuMatches[Math.min(menuIdx, menuMatches.length - 1)]!.name;
        setEditor({ text: pick + " ", cursor: pick.length + 1 });
      } else if (input.startsWith("/")) {
        // Fuzzy fallback for typos (e.g. /compcat -> /compact).
        const match = closest(input, slashNames, 4);
        if (match) setEditor({ text: match + " ", cursor: match.length + 1 });
      }
      return;
    }
    if (key.return) {
      if (submitGuard.current) return; // block duplicate Enter events (Windows \r\n split)
      submitGuard.current = true;
      // Slash-command palette: when the suggestion menu is open, Enter runs the
      // HIGHLIGHTED command, completing a partial (e.g. "/age" → "/agents"). Tab
      // instead fills it into the box (for commands that take arguments).
      const value = resolveSubmit(input, menuMatches.map((m) => m.name), menuIdx);
      if (value.trim()) {
        const h = historyRef.current;
        if (h[h.length - 1] !== value) h.push(value);
      }
      setEditor({ text: "", cursor: 0 });
      setHistoryIdx(null);
      if (value.startsWith("/")) {
        void runSlash(value);
      } else {
        void submit(value);
      }
      return;
    }
    // Backspace. A single press arrives as key.backspace (0x08) or key.delete
    // (0x7f). HELD backspace (auto-repeat) arrives as a batched chunk like
    // "\x7f\x7f\x7f" that Ink does NOT flag — so detect that too and delete N.
    let bs = 0;
    if (key.backspace || key.delete) bs = 1;
    else if (input2 && /^[\x08\x7f]+$/.test(input2)) bs = input2.length;
    if (bs > 0) {
      setEditor((e) => {
        const c = Math.max(0, e.cursor - bs);
        return { text: e.text.slice(0, c) + e.text.slice(e.cursor), cursor: c };
      });
      return;
    }
    // Insert printable input. Strip control characters so stray DEL/BS bytes
    // from key bursts are never inserted (which previously pushed the caret).
    if (input2 && !key.ctrl && !key.meta) {
      const clean = input2.replace(/[\x00-\x1F\x7F]/g, "");
      if (clean) setEditor((e) => ({ text: e.text.slice(0, e.cursor) + clean + e.text.slice(e.cursor), cursor: e.cursor + clean.length }));
    }
  });

  const endpoint = defaultEndpoint(config.provider, config.baseUrl);
  const isLocal = config.provider === "ollama" || config.provider === "lmstudio";

  return (
    <Box flexDirection="column">
      {/* Settled history lives in Static: the intro banner first, then every
          message from finished turns. Static writes each item to scrollback
          exactly once, so this whole region never re-renders. */}
      <Static
        items={[
          // The intro joins Static only after the launch splash settles, so it's
          // written to scrollback exactly once, frozen (eyes open).
          ...(introReady ? [{ kind: "intro" as const, key: "intro" }] : []),
          ...messages.slice(0, settled).filter((m) => m.id).map((m, i) => ({ kind: "msg" as const, key: `${m.id}:${i}`, m })),
        ]}
      >
        {(item) =>
          item.kind === "intro" ? (
            <Intro key={item.key} provider={config.provider} model={model} endpoint={endpoint} isLocal={isLocal} providerNote={providerReason(config.provider, config.source.provider)} hasKey={!!config.apiKey} theme={theme} />
          ) : (
            <Box key={item.key} paddingX={1}>
              <MessageLine m={item.m} theme={theme} />
            </Box>
          )
        }
      </Static>

      {/* Launch splash: the half-size Bubo blinks here for a beat, then settles
          into <Static> above. Messages are empty during this window, so it sits
          at the top where the frozen intro will land. */}
      {!introReady && (
        <Box paddingX={1}>
          <Intro provider={config.provider} model={model} endpoint={endpoint} isLocal={isLocal} providerNote={providerReason(config.provider, config.source.provider)} hasKey={!!config.apiKey} theme={theme} blink={introBlink} />
        </Box>
      )}

      {/* The in-flight turn (and transient status) — the only part that reflows. */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {messages.slice(settled).filter((m) => m.id).map((m, i) => (
            <MessageLine key={`${m.id}:${settled + i}`} m={m} theme={theme} />
          ))}
          {busy && (
            <Text color={theme.hex.warning}>
              {reducedMotion ? "•" : SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} Working… <Text dimColor>({Math.max(0, Math.floor((Date.now() - busyStartRef.current) / 1000))}s · esc to interrupt)</Text>
            </Text>
          )}
          {errorLine && <Text color={theme.hex.error}>! {errorLine}</Text>}
        </Box>
        {showTasks && (
          <Box flexDirection="column" width={28} paddingX={1} borderStyle="single" borderColor={theme.border}>
            <Text bold>Tasks</Text>
            <Text dimColor>(no active tasks)</Text>
          </Box>
        )}
      </Box>

      {!pending && menuMatches.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          {menuMatches.map((m, i) => {
            const sel = i === Math.min(menuIdx, menuMatches.length - 1);
            return (
              <Text key={m.name} color={sel ? theme.user : undefined} dimColor={!sel}>
                {sel ? "❯ " : "  "}{m.name}{m.desc ? `  —  ${m.desc}` : ""}
              </Text>
            );
          })}
          <Text dimColor>  ↑/↓ select · Enter run · Tab fill (for args)</Text>
        </Box>
      )}

      {/* Bubo on his own row above the input — known-good layout (no input-box
          reflow). Right-aligned, eyes darting while a turn runs. */}
      <Box paddingX={1} justifyContent="flex-end">
        <Text color={theme.hex.assistant}>{busy && !reducedMotion ? OWL_FRAMES[Math.floor(tick / 3) % OWL_FRAMES.length] : OWL_MICRO}</Text>
      </Box>
      {pending ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.hex.warning} paddingX={1} marginTop={1}>
          <Text>
            <Text color={theme.hex.warning}>⚠ Approve tool </Text>
            <Text bold color={theme.hex.warning}>{pending.tool}</Text>
            <Text dimColor>?</Text>
          </Text>
          <Text dimColor>{pending.argsSummary}</Text>
        </Box>
      ) : modelPicker ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.user} paddingX={1} marginTop={1}>
          <Text bold color={theme.user}>Select a model — {config.provider}</Text>
          {(() => {
            const height = 12;
            const { slice, offset } = pickerWindow(modelPicker.items, modelPicker.idx, height);
            const tail = modelPicker.items.length - offset - slice.length;
            return (
              <>
                {offset > 0 && <Text dimColor>{`  ↑ ${offset} more`}</Text>}
                {slice.map((m, i) => {
                  const sel = offset + i === modelPicker.idx;
                  const isCurrent = m === model;
                  return (
                    <Text key={m} color={sel ? theme.user : undefined} dimColor={!sel}>
                      {sel ? "❯ " : "  "}{isCurrent ? "→ " : "  "}{m}
                    </Text>
                  );
                })}
                {tail > 0 && <Text dimColor>{`  ↓ ${tail} more`}</Text>}
              </>
            );
          })()}
          <Text dimColor>  ↑/↓ select · Enter switch · Esc cancel</Text>
        </Box>
      ) : picker ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.user} paddingX={1} marginTop={1}>
          <Text bold color={theme.user}>Resume a session</Text>
          {picker.items.map((s, i) => {
            const sel = i === picker.idx;
            const label = s.title || s.preview || "(empty session)";
            return (
              <Text key={s.id} color={sel ? theme.user : undefined} dimColor={!sel}>
                {sel ? "❯ " : "  "}{label.padEnd(42).slice(0, 42)}  <Text dimColor>{`${s.count} msg · ${relTime(s.mtime)}`}</Text>
              </Text>
            );
          })}
          <Text dimColor>  ↑/↓ select · Enter resume · Esc cancel</Text>
        </Box>
      ) : (
        <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
          <Text>
            <Text color={theme.user}>› </Text>
            <Text>{input.slice(0, cursor)}</Text>
            <Text inverse>{input.slice(cursor, cursor + 1) || " "}</Text>
            <Text>{input.slice(cursor + 1)}</Text>
          </Text>
        </Box>
      )}
      <Box paddingX={1} flexDirection="row" justifyContent="space-between">
        {pending ? (
          <Text dimColor>[y] allow once · [a] allow always · [n] deny (esc)</Text>
        ) : busy ? (
          <Text dimColor>esc to interrupt</Text>
        ) : (
          <Text> </Text>
        )}
        <Text>
          {planMode && <Text color={theme.hex.warning}>PLAN  </Text>}
          <ConfidenceBadge state={confidence} theme={theme} />
          <Text dimColor>  · ctx </Text>
          <Text color={{ ok: theme.hex.success, warn: theme.hex.warning, crit: theme.hex.error }[contextTone(ctxFill)]}>{contextBar(ctxFill)}</Text>
          <Text dimColor> {Math.round(ctxFill * 100)}%{ctxTokens > 0 ? ` (${formatTokens(ctxTokens)}/${formatTokens(trackerRef.current.window())})` : ""} · </Text>
          <Text color={theme.hex.assistant}>{model}</Text>
          <Text dimColor>  cost </Text>
          <Text color={theme.hex.success}>${costUsd.toFixed(4)}</Text>
        </Text>
      </Box>
    </Box>
  );
}
