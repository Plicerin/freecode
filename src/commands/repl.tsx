import React, { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { loadConfig, type CliFlags } from "../config/loader";
import { buildProvider } from "../providers/registry";
import { detectLocalModels, detectServerKind, detectLlamaServerContext, detectOllamaContext } from "../providers/local-context";
import { discoverServers, type DiscoveredServer } from "../providers/server-discovery";
import { zodToJsonSchema } from "../providers/schema-util";
import { buildToolRegistry, toolListToSystemPrompt } from "../tools/registry";
import { createPermissionEngine, approvalDecisionForKey, type ApprovalCallback, type ApprovalDecision, type ApprovalRequest, type PermissionEngine } from "../permissions/modes";
import { makeGrantStore } from "../config/permission-grants";
import { VERSION } from "../version";
import { checkForUpdate, baseVersion, UPDATE_HINT } from "../agent/update-check";
import { runAgentLoop } from "../agent/loop";
import { branch as gitBranch, commitPushPr, issue as ghIssue, prComments } from "./git-workflow";
import { createAgentTool } from "../tools/agent";
import { resolveAgentTypes } from "../agent/agent-types";
import { resolveSkills, getSkill } from "../agent/skills";
import { resolveWorkflows, getWorkflow, runWorkflow, composeWorkflow, type WorkflowEvent } from "../agent/workflow";
import { filterChatModels, orderChatModels, pickerWindow, searchModels, sortFreeFirst } from "../tui/model-picker";
import { matchCommands, resolveSubmit } from "../tui/slash-complete";
import { createApprovalQueue } from "../tui/approval-queue";
import { resolvePlugins, setPluginEnabled, installPlugin, uninstallPlugin } from "../plugins";
import { startBackground } from "../background/runner";
import { reapJobs } from "../background/registry";
import { formatJobLine } from "./background-cli";
import { analyzeSession, applyProposal, dedupeProposals, transcriptFromMessages, type Proposal } from "../agent/self-improve";
import { ensureStat, listStats, decayCandidates, verifyTrend, pruneArtifact } from "../agent/learn-stats";
import { readFileSync as readFileForLearn, appendFileSync, existsSync } from "node:fs";
import { APP_DIR, SETTINGS_PATH } from "../utils/paths";
import { ContextTracker } from "../agent/context";
import { priceFor, contextWindowFor } from "../agent/pricing";
import { estimateMessagesTokens } from "../agent/token-estimate";
import { contextBar, contextTone, formatTokens } from "../tui/context-bar";
import { extractAttachments } from "../agent/attachments";
import { summarizeConversation } from "../agent/summarize";
import { Vault } from "../config/vault";
import { loadCustomCommands, expandCommand } from "./custom-commands";
import { executeBench, formatBenchPlain } from "./bench";
import { previewToolResult } from "../tui/preview";
import { type Confidence, nextConfidence } from "../tui/confidence";
import { ICON, SPINNER_FRAMES } from "../tui/icons";
import { MarkdownBody } from "../tui/markdown-render";
import { BRACKET_PASTE_ON, BRACKET_PASTE_OFF, hasPasteStart, pastePlaceholder, expandPastes, shouldCollapse, normalizeNewlines } from "../tui/paste";
import { tokensPerSecond, estTokens, formatSpeed, streamHealth } from "../tui/speed";
import { isLanModelEndpoint, endpointHostLabel } from "../tui/endpoint";
import { CONSULT_PROVIDERS, supervisorPrompt, consultBanner } from "../tui/consult";
import type { ResolvedConfig } from "../config/schema";
import { parseMcpAdd, addMcpServer, removeMcpServer, listConfiguredMcp } from "../config/mcp-edit";
import { logActivity, setActivityLog, activityState } from "../utils/activity";
import { closest } from "../utils/fuzzy";
import { resolveVerify, resolveQuickVerify, runVerify } from "../agent/verify";
import { newSession, appendEvent, resumeSession, readSession, setSessionTitle, titleOf, toolOutputs, listSessionMetas, writeConversationState, readConversationState, type Session, type SessionMeta, type SessionEvent } from "../session/manager";
import { collectSnapshots, writeRecovered, currentFileInfo } from "../session/recover";
import { isAbsolute as pathIsAbsolute, resolve as pathResolve } from "node:path";
import { setTerminalTitle } from "../tui/terminal-title";
import { writeLastSession } from "../config/last-session";
import { goalPrompt, goalStatus, goalVerifyFailedPrompt, goalMax } from "../agent/goal";
import { degenerationReason } from "../agent/degeneration";
import { basename } from "node:path";
import { historyFromEvents } from "../session/history";
import { createMemoryStore, type MemoryStore } from "../memory/store";
import { makeTheme } from "../tui/theme";
import { Mascot, OWL_MICRO, OWL_FRAMES, MASCOT_BIO } from "../tui/mascot";
import { debug } from "../utils/debug";
import type { Tool } from "../tools/types";
import { bashShellName } from "../tools/bash";
import type { ChatMessage } from "../providers/types";
import type { McpManager, McpServerStatus } from "../mcp/manager";

export interface ReplOptions {
  flags?: CliFlags;
  resumeId?: string;
  initialPrompt?: string;
  extraTools?: Tool[];
  mcpStatus?: McpServerStatus[];
  /** Live MCP manager — lets `/mcp add|remove` hot-load servers without a restart. */
  mcp?: McpManager;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "ledger" | "warning" | "reasoning";
  text: string;
  toolName?: string;
  ok?: boolean;
}

export type StaticItem =
  | { kind: "intro"; key: string }
  | { kind: "msg"; key: string; m: UiMessage };

/** The <Static> scrollback items. INVARIANT: append-only — Ink's <Static> tracks
 *  by COUNT and only writes items past what it already emitted, so mutating a
 *  PREFIX makes it re-emit shifted items (and repaint from the top). The old code
 *  prepended the intro once the splash settled; if a startup message (memory/MCP
 *  status) had already landed in Static before that, prepending shifted it → the
 *  message duplicated and the terminal jumped to the top. Fix: gate everything on
 *  `introReady` — Static stays empty until the splash settles, then it's
 *  [intro, ...settled messages] and only ever grows at the end. */
export function buildStaticItems(introReady: boolean, messages: UiMessage[], settled: number, base = 0): StaticItem[] {
  if (!introReady) return [];
  // `base` is the first message the CURRENT <Static> mount is responsible for. On
  // a marathon session the mount is periodically reset (see STATIC_WINDOW) so Ink
  // can free the render trees of already-scrolled-off messages; everything before
  // `base` is already in the terminal's native scrollback. The intro only belongs
  // to the first mount (base 0).
  const items: StaticItem[] = base <= 0 ? [{ kind: "intro", key: "intro" }] : [];
  const slice = messages.slice(base, settled).filter((m) => m.id);
  for (let i = 0; i < slice.length; i++) items.push({ kind: "msg", key: `${slice[i]!.id}:${base + i}`, m: slice[i]! });
  return items;
}

// How many settled messages the live <Static> mount holds before it's reset to
// free Ink's retained render trees. Large enough that a normal session never
// resets — only a marathon autonomous run (hundreds of tool calls) does.
export const STATIC_WINDOW = 1000;

// The in-flight turn renders in Ink's DYNAMIC region, which Ink repaints every
// frame by moving the cursor up and erasing `lastOutputHeight` lines. Once that
// region grows TALLER than the terminal viewport, the lines that scrolled off the
// top can't be erased, so the repaint corrupts — a long streamed reply visibly
// garbles or VANISHES halfway through (worst with verbose local models). Bound the
// live region to the viewport: show only the TAIL that fits. Nothing is lost — the
// FULL message prints into <Static> (which is written once and scrolls natively,
// never repainted) the instant the turn settles. Returns the clamped text and
// whether anything was dropped, plus the wrapped-row count it occupies.
export function clampToViewport(text: string, maxRows: number, width: number): { text: string; clipped: boolean; rows: number } {
  const cols = Math.max(20, width || 80);
  const wrapped = (line: string) => Math.max(1, Math.ceil(line.length / cols));
  const lines = text.split("\n");
  let used = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = wrapped(lines[i]!);
    if (kept.length > 0 && used + r > maxRows) return { text: kept.join("\n"), clipped: true, rows: used };
    used += r;
    kept.unshift(lines[i]!);
  }
  return { text, clipped: false, rows: used };
}

/**
 * Fold a batch of COALESCED streamed text (accumulated reasoning + answer deltas)
 * into the transcript in ONE step — the pure core of the repl's flushStream.
 *
 * Streamed deltas are buffered and flushed at ~30fps instead of one setMessages
 * per token (which drove one React/Ink commit per token and leaked heap until a
 * long stream OOM'd). Bubble ids are decided UP FRONT and returned so the caller
 * can commit them to refs SYNCHRONOUSLY — never inside a setState updater, which
 * may run batched/later and would race the tool_call handler's ref reset. A
 * truthy incoming id means the bubble already exists (append); a null id means
 * create it. The first answer text closes the reasoning bubble (returns thinkId
 * null), matching the live per-token behaviour exactly.
 */
export function planStreamFlush(
  ids: { thinkId: string | null; answerId: string | null },
  pending: { think: string; answer: string },
  newId: (kind: "reasoning" | "assistant") => string,
): { thinkId: string | null; answerId: string | null; apply: (msgs: UiMessage[]) => UiMessage[] } {
  const { think, answer } = pending;
  const thinkId0 = ids.thinkId;
  const answerId0 = ids.answerId;
  const thinkId = think && !thinkId0 ? newId("reasoning") : thinkId0;
  const answerId = answer && !answerId0 ? newId("assistant") : answerId0;
  const apply = (msgs: UiMessage[]): UiMessage[] => {
    let next = msgs;
    if (think) {
      next = thinkId0
        ? next.map((m) => (m.id === thinkId ? { ...m, text: m.text + think } : m))
        : [...next, { id: thinkId!, role: "reasoning", text: think }];
    }
    if (answer) {
      next = answerId0
        ? next.map((m) => (m.id === answerId ? { ...m, text: m.text + answer } : m))
        : [...next, { id: answerId!, role: "assistant", text: answer }];
    }
    return next;
  };
  // The answer, once it starts, closes the reasoning bubble so later reasoning
  // (rare, interleaved) opens a fresh one.
  return { thinkId: answer ? null : thinkId, answerId, apply };
}

/** Rebuild the visible transcript from a session's stored events for /resume.
 *  Mirrors how the LIVE stream renders: a tool_call becomes "→ name(args)" and a
 *  tool_result becomes its output preview — NOT a bare ⚙. The old restore read
 *  `e.text` (tool_result stores `output`) and dropped tool_call events entirely,
 *  so a resumed session showed rows of empty gears. Empty assistant turns
 *  (tool-only) are skipped, as live. */
export function restoredMessagesFromEvents(events: SessionEvent[], sessionId: string): UiMessage[] {
  const out: UiMessage[] = [];
  events.forEach((e, i) => {
    const id = `${sessionId}-${i}`;
    if (e.kind === "user") out.push({ id, role: "user", text: e.text });
    else if (e.kind === "assistant") { if (e.text.trim()) out.push({ id, role: "assistant", text: e.text }); }
    else if (e.kind === "tool_call") out.push({ id, role: "tool", text: `${ICON.toolCall} ${e.name}(${JSON.stringify(e.args).slice(0, 120)})`, toolName: e.name });
    else if (e.kind === "tool_result") out.push({ id, role: "tool", text: previewToolResult(e.output), toolName: "result", ok: e.ok });
  });
  return out;
}

// Programmatic "user" turns that the human did NOT type at the prompt — the /goal
// cycle FRAME, the verify-failed re-prompt, the /explore framing. They're real
// user TURNS for the model but must not pollute the up/down INPUT history.
const NON_TYPED_PROMPT = /working AUTONOMOUSLY toward a goal|^You reported GOAL: DONE|^Use the Agent tool with subagent_type/m;

/** The up/down-arrow input history for a resumed session: the prompts the user
 *  actually typed, oldest first (the FRAME/agentic auto-prompts filtered out,
 *  consecutive dupes collapsed). */
export function inputHistoryFromEvents(events: SessionEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== "user" || !e.text.trim() || NON_TYPED_PROMPT.test(e.text)) continue;
    if (out[out.length - 1] !== e.text) out.push(e.text);
  }
  return out;
}

const SLASH_COMMANDS = ["/model", "/models", "/new", "/resume", "/rename", "/context", "/cost", "/memory", "/config", "/doctor", "/diff", "/commit", "/commit-push-pr", "/branch", "/issue", "/pr-comments", "/review", "/security-review", "/autofix-pr", "/explore", "/agents", "/skills", "/learn", "/goal", "/expand", "/recover", "/workflows", "/ultraplan", "/bg", "/plugins", "/provider", "/scan", "/consult", "/advisor", "/plan", "/verify", "/bench", "/log", "/mcp", "/help", "/compact", "/about", "/exit"];

// Spinner frames — proof of life while a turn runs. Not the braille snake every
// The "Working…" spinner + all UI glyphs come from the central icon set
// (src/tui/icons.ts): one place to swap sets (nerd/unicode/ascii via FREECODE_ICONS)
// and keep them consistent. SPINNER_FRAMES is the mode-resolved moon spinner.

// A streamed workflow event → one status line (or null to swallow it). Shared by
// /workflows and /ultraplan so both show live per-stage / per-task progress.
function workflowEventLine(e: WorkflowEvent): string | null {
  if (e.type === "stage_start") return `  ${SPINNER_FRAMES[0]} stage ${e.index + 1}${e.name ? ` (${e.name})` : ""} — ${e.tasks} task${e.tasks > 1 ? "s" : ""} running…`;
  if (e.type === "task_activity") return `       ${e.agent ?? "general"} ${e.label}`;
  if (e.type === "task_done") return `     ${e.ok ? ICON.ok : ICON.fail} ${e.agent ?? "general"} done`;
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
  "/scan": "discover Ollama + llama-server on the network, then pick a server & model to switch to (/scan ollama|llama-server to filter)",
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
  "/goal": "work autonomously toward an objective until done (/goal <objective>, /goal stop)",
  "/expand": "show the full output of a truncated tool result (/expand [n], n=1 = most recent)",
  "/recover": "restore an earlier version of a file from backups/session log to <file>.recovered (/recover <file> [n])",
  "/plugins": "list/install/uninstall/enable/disable plugins (/plugins install <git-url|path>)",
  "/verify": "run the project's checks",
  "/bench": "race the performance ghost",
  "/log": "toggle the verification activity log",
  "/help": "list commands",
  "/memory": "show/refresh cross-session memory (/memory [refresh|show])",
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
    case "llama-server": return "http://127.0.0.1:8080/v1";
    case "nim": return "https://integrate.api.nvidia.com/v1";
    case "openrouter": return "https://openrouter.ai/api/v1";
    case "deepseek": return "https://api.deepseek.com/v1";
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
        "github-models": "GITHUB_TOKEN", nim: "NVIDIA_API_KEY", deepseek: "DEEPSEEK_API_KEY", ollama: "OLLAMA_HOST", lmstudio: "LMSTUDIO_HOST", "llama-server": "LLAMA_SERVER_HOST",
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
    case "verified": return <Text color={theme.hex.success}>{ICON.ok} verified</Text>;
    case "unverified": return <Text color={theme.hex.warning}>~ unverified</Text>;
    case "failing": return <Text color={theme.hex.error}>{ICON.fail} failing</Text>;
    default: return <Text dimColor>{ICON.bullet} unchecked</Text>;
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
  eyeOffset?: number;
}

function Intro({ provider, model, endpoint, isLocal, providerNote, hasKey, theme, eyeOffset = 0 }: IntroProps): JSX.Element {
  const label = (s: string) => <Text color={theme.dim}>{s.padEnd(10)}</Text>;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" marginLeft={1}>
        <Mascot theme={theme} eyeOffset={eyeOffset} />
        <Box flexDirection="column" justifyContent="center" marginLeft={3}>
          <Banner />
          <Box marginTop={1}>
            <Text color={theme.hex.assistant}>{ICON.sparkle} </Text>
            <Text>Total freedom. No guesswork.</Text>
            <Text color={theme.hex.assistant}> {ICON.sparkle}</Text>
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
        <Text color={theme.hex.success}>{ICON.ready} </Text>
        <Text color={theme.dim}>{(isLocal ? "local" : "remote").padEnd(8)}</Text>
        <Text color={theme.dim}>Ready — type </Text>
        <Text color={theme.hex.assistant}>/help</Text>
        <Text color={theme.dim}> to begin</Text>
      </Box>
      <Box marginLeft={1} marginTop={1}>
        <Text color={theme.dim}>freecode </Text>
        <Text color={theme.hex.assistant}>{VERSION}</Text>
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
    // The reply renders in a 2-col gutter: the ● marker sits in the gutter and
    // the markdown body is a wrapping column beside it, so continuation lines and
    // code align UNDER the prose instead of falling back to the left edge — the
    // turn reads as one block. A blank line above separates it from the prior
    // step (spacing pass — the transcript was a flush wall of text before).
    const body = (
      <Box flexDirection="row">
        <Text color={theme.hex.assistant}>{ICON.assistant} </Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <MarkdownBody text={m.text} theme={theme} />
        </Box>
      </Box>
    );
    return <Box marginTop={1}>{body}</Box>;
  }
  // YOUR prompt stands out: a blank line above sets each exchange apart, and the
  // emoji + bold + brand color make it easy to find when scanning back.
  if (m.role === "user") {
    // Normalise any stray CR (e.g. a paste persisted before the capture-time fix,
    // or a resumed older session) so a lone "\r" can't overwrite earlier lines and
    // leave only the last one visible.
    return <Box marginTop={1}><Text color={theme.user} bold>{`${ICON.user} `}{normalizeNewlines(m.text)}</Text></Box>;
  }
  // Sub-steps of the current turn — tool calls/results, reasoning, ledger, system
  // notes, inline warnings — sit indented under the reply with NO extra blank
  // line, so a run of tool calls groups tightly beneath the answer it belongs to.
  if (m.role === "warning") {
    return <Box marginLeft={2}><Text color={theme.hex.warning} bold>{`${ICON.warn} `}{m.text}</Text></Box>;
  }
  if (m.role === "reasoning") {
    return <Box marginLeft={2}><Text color={theme.dim} italic>{`${ICON.thinking} `}{m.text}</Text></Box>;
  }
  return (
    <Box marginLeft={2}>
      <Text>
        {m.role === "tool" && <Text color={theme.hex.assistant}>{ICON.tool} </Text>}
        {m.role === "system" && <Text color={theme.dim}>{ICON.bullet} </Text>}
        <Text color={m.role === "ledger" ? theme.dim : undefined} dimColor={m.role === "ledger"}>{m.text}</Text>
      </Text>
    </Box>
  );
}

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  let config = loadConfig({ flags: opts.flags ?? {} });

  // First-run onboarding: no key anywhere for a cloud provider → collect them.
  const localProvider = ["ollama", "lmstudio", "llama-server", "mock"].includes(config.provider);
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
      mcp={mcp}
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

export function Repl({ flags, resumeId, initialPrompt, extraTools, mcpStatus, mcp }: ReplOptions): JSX.Element {
  const { exit } = useApp();
  // Config is stateful so /provider can switch the active provider live
  // (re-resolving that provider's key/baseUrl/model from the vault + settings).
  const [config, setConfig] = useState(() => loadConfig({ flags: flags ?? {} }));
  const theme = useMemo(() => makeTheme(config.theme), [config.theme]);
  const provider = useMemo(() => buildProvider(config), [config]);
  // MCP tools/status live in state so `/mcp add|remove` can hot-load servers
  // without a restart. Seeded from the manager's startup connections.
  const [mcpTools, setMcpTools] = useState<Tool[]>(() => mcp?.tools ?? extraTools ?? []);
  const [mcpStatusState, setMcpStatusState] = useState<McpServerStatus[]>(() => mcp?.status ?? mcpStatus ?? []);
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
      ...mcpTools,
    ],
    [config.webSearchProvider, mcpTools],
  );
  // The permission engine holds mutable session state — the "allow always"
  // allowlist. It MUST be one stable instance for the whole session: useMemo is
  // only a perf hint (React may discard it), and discarding the engine silently
  // drops your approvals so a tool you allowed-always keeps re-prompting. Pin it
  // in a ref (created once); a live permission-mode change syncs onto it below
  // instead of rebuilding, so switching provider/model never forgets approvals.
  const permissionRef = useRef<PermissionEngine | null>(null);
  if (!permissionRef.current) permissionRef.current = createPermissionEngine(config.permissionMode, { grants: makeGrantStore(process.cwd()) });
  const permission = permissionRef.current;
  useEffect(() => { permission.setMode(config.permissionMode); }, [config.permissionMode]);
  const trackerRef = useRef(
    new ContextTracker({
      threshold: config.contextThreshold,
      windowSize: contextWindowFor(config.model),
      pricing: priceFor(config.model, config.provider),
    }),
  );
  const sessionRef = useRef<Session>(undefined as unknown as Session);
  const memoryRef = useRef<MemoryStore | undefined>(undefined); // cross-session memory (Honcho)
  const conversationRef = useRef<ChatMessage[]>([]); // running provider-format history
  // The context window a LOCAL server actually loaded the model with (LM Studio),
  // which can be far below the model's name-based max. Overrides contextWindowFor
  // for compaction + the overflow guard when detected. See the effect below.
  const detectedWindowRef = useRef<number | null>(null);
  const windowFor = (m: string): number => detectedWindowRef.current ?? contextWindowFor(m);
  // Connection/throughput-health colour for the live "Working…" line: teal while
  // healthy, amber when slow/quiet, coral when silent ≥20s OR crawling. The idle
  // watchdog can't see a CRAWL (a trickle of tokens keeps the stream "alive"), so
  // we fold live tok/s in: a sustained <2 tok/s burst is as bad as silence.
  // Recomputed each spinner tick.
  const workingHealthColor = (): string => {
    const start = burstStartRef.current;
    const burstMs = start ? Date.now() - start : 0;
    const tps = start ? tokensPerSecond(estTokens(burstCharsRef.current), burstMs) : null;
    const health = streamHealth(Date.now() - lastActivityRef.current, burstMs, tps);
    return health === "stalled" ? theme.hex.error : health === "slow" ? theme.hex.warning : theme.hex.success;
  };
  // Dedups the local-model detection announcement so the effect re-running after
  // an auto model-switch doesn't repeat the message.
  const lastLocalDetectRef = useRef<string>("");
  // Detected server kind for a local provider (e.g. a llama.cpp server reached via
  // the lmstudio provider) → shown in the status line instead of the raw provider.
  const [serverLabel, setServerLabel] = useState<string | null>(null);

  const customCommands = useMemo(() => loadCustomCommands(process.cwd()), []);
  // Project skills are invocable by name too (/<skill> [args]); surface them in
  // autocomplete alongside built-in and custom commands.
  const projectSkills = useMemo(() => resolveSkills(process.cwd()), []);
  const slashNames = useMemo(
    () => [
      ...SLASH_COMMANDS,
      ...[...customCommands.keys()].map((n) => `/${n}`),
      ...projectSkills.map((s) => `/${s.name}`),
    ],
    [customCommands, projectSkills],
  );

  const [messages, setMessages] = useState<UiMessage[]>([]);
  // How many leading messages are "settled" (turn finished, no longer changing)
  // and so can live in <Static> — written to terminal scrollback once and never
  // re-rendered. Only the in-flight turn stays in the dynamic region, which
  // keeps the input box anchored instead of hopping as content grows.
  const [settled, setSettled] = useState(0);
  // A marathon /goal keeps appending to <Static>, whose committed render trees Ink
  // retains for the whole mount — memory grows ~O(n²) with tool-call volume and
  // OOMs. Periodically remount Static past a large window so Ink frees scrolled-off
  // trees (the lines stay in the terminal's own scrollback). `staticBase` is the
  // first message the live mount owns; `staticEpoch` is its <Static> key.
  const [staticEpoch, setStaticEpoch] = useState(0);
  const [staticBase, setStaticBase] = useState(0);
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
    () => matchCommands(input, slashNames).map((n) => ({ name: n, desc:
      COMMAND_DESC[n]
      ?? customCommands.get(n.slice(1))?.description
      ?? projectSkills.find((s) => s.name === n.slice(1))?.description
      ?? "" })),
    [input, slashNames, customCommands, projectSkills],
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
  // Synchronous mirror of historyIdx. The input handler decides history-vs-menu
  // from THIS (always current), not the state value — Ink can fire a held/fast
  // arrow before the re-render lands, and a stale historyIdx let the slash menu
  // hijack scrolling at a recalled /command. Updated alongside every setHistoryIdx.
  const historyIdxRef = useRef<number | null>(null);
  const draftRef = useRef(""); // live input saved while browsing history
  // The slash menu is "open" only while TYPING a command — not when a /command
  // was recalled via history (else up/down would hijack to menu-nav and you'd be
  // stuck on it, and Enter would run the highlighted item, not what you recalled).
  const menuOpen = menuMatches.length > 0 && historyIdx === null;
  const [busy, setBusy] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const [ctxFill, setCtxFill] = useState(0); // 0..1 — how full the context window is
  const [ctxTokens, setCtxTokens] = useState(0); // tokens currently in context
  const [confidence, setConfidence] = useState<Confidence>("unchecked");
  const [tick, setTick] = useState(0); // drives the spinner + Bubo's eyes while working
  const busyStartRef = useRef(0);
  // Last moment the in-flight turn produced ANY stream activity (token, tool call,
  // usage). Drives the "Working…" health colour — how long we've been silent.
  const lastActivityRef = useRef(0);
  // Emit the "generating very slowly" warning at most once per turn.
  const crawlWarnedRef = useRef(false);
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  // Interactive resume picker: when open, ↑/↓ choose and Enter resumes.
  const [picker, setPicker] = useState<{ items: SessionMeta[]; idx: number } | null>(null);
  // Interactive model picker: when open, ↑/↓ choose and Enter switches.
  const [modelPicker, setModelPicker] = useState<{ all: string[]; query: string; idx: number } | null>(null);
  // /consult two-stage picker: choose a supervisor provider, then its model. The
  // carried `task` is what the supervisor gets once a model is picked.
  const [consultPicker, setConsultPicker] = useState<
    | { stage: "provider"; task: string; items: string[]; idx: number }
    | { stage: "model"; task: string; providerId: string; cfg: ResolvedConfig; all: string[]; query: string; idx: number }
    | null
  >(null);
  // /scan two-stage picker: choose a discovered server (Ollama or llama-server),
  // then its model. Selecting one switches the live provider to that endpoint —
  // no hand-typed address (the whole point: the address moves, discovery doesn't).
  const [scanPicker, setScanPicker] = useState<
    | { stage: "server"; servers: DiscoveredServer[]; idx: number }
    | { stage: "model"; servers: DiscoveredServer[]; server: DiscoveredServer; all: string[]; query: string; idx: number }
    | null
  >(null);
  // Self-improvement: proposals from the last /learn, awaiting /learn save <n|all>.
  const learnProposalsRef = useRef<Proposal[]>([]);
  // /goal: true while an autonomous goal loop is running (esc or /goal stop ends it).
  // The ref is read synchronously in the input handler; the state mirror lets the
  // input-drain effect RE-RUN when a goal ends (a ref change doesn't re-render), so
  // input queued during a goal drains the moment it finishes. Keep them in lockstep.
  const goalActiveRef = useRef(false);
  const [goalActive, setGoalActive] = useState(false);
  // Approval prompts are QUEUED, not held in a single slot. Parallel sub-agents
  // (a workflow fan-out) can each need approval at the same instant; a lone
  // resolver let the second prompt clobber the first, orphaning its promise so
  // the stage's Promise.all waited forever (the /ultraplan "hang"). The queue
  // serialises them: one shows at a time (driving `pending`), the rest wait.
  const approvalQueue = useRef(createApprovalQueue(setPending)).current;
  const abortRef = useRef<AbortController | null>(null);
  const streamIdRef = useRef<string | null>(null); // id of the assistant bubble currently streaming
  const thinkIdRef = useRef<string | null>(null); // id of the reasoning bubble currently streaming
  // Streamed text is COALESCED: deltas accumulate in these buffers and flush to
  // React state at ~30fps (see flushStream), NOT once per token. A setMessages
  // per token drove one React commit per token — and Ink retains heap on every
  // commit — so a long stream from a fast model climbed to Node's ~4GB heap cap
  // and OOM'd. Coalescing decouples the render count from the token count.
  const pendingAnswerRef = useRef(""); // streamed answer text not yet in state
  const pendingThinkRef = useRef(""); // streamed reasoning text not yet in state
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live tokens/sec speedometer: chars produced in the current generation burst
  // and when it started (reset on each tool call so it tracks the live stream,
  // not wall-clock that includes tool-execution pauses).
  const burstCharsRef = useRef(0);
  const burstStartRef = useRef<number | null>(null);
  // Run-level totals (across all bursts of one submit) for the persistent
  // per-turn "⚡ N tok/s" summary: chars produced + ms actually spent generating
  // (excludes tool-execution pauses).
  const genCharsRef = useRef(0);
  const genMsRef = useRef(0);
  // Messages typed WHILE a turn is running are queued, not dropped. submit()
  // refuses to run concurrently (returns early if busy), so without this a line
  // entered mid-turn vanished on Enter — the user couldn't steer the agent. We
  // hold them here and drain one when the turn finishes (see the effect below).
  const queuedInputRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  // Multi-line pastes are collapsed to a "[#N +L lines]" chip in the input; the
  // real content is kept here and substituted back in at submit (Claude-Code style).
  const pasteRef = useRef<{ next: number; map: Map<number, string> }>({ next: 1, map: new Map() });
  // While a bracketed paste is arriving across chunks, the per-line pieces collect
  // here (null = not currently inside a paste).
  const pasteCollectRef = useRef<string[] | null>(null);

  // Exit cleanly: abort any in-flight turn first so spawned tool processes (e.g.
  // a running test suite) are signaled to die — otherwise their open pipes keep
  // the runtime alive and the process appears to hang after the UI closes.
  // Terminal tab title = the session name (its /rename title, else the project
  // folder). Reset to plain "freecode" on exit so the tab isn't left stale.
  const cwdBase = basename(process.cwd());
  const applyTabTitle = (name?: string): void => setTerminalTitle(name?.trim() || cwdBase);

  const exitNow = (): void => {
    setTerminalTitle("freecode");
    if (process.stdout.isTTY) process.stdout.write(BRACKET_PASTE_OFF);
    abortRef.current?.abort();
    approvalQueue.flush(); // unblock any sub-agents parked on a prompt so the process can die
    exit();
  };

  // Bracketed paste: ask the terminal to wrap pasted text so a multi-line paste
  // arrives as one burst (collapsible to a chip) instead of raw newlines that
  // strip or fire a premature submit. Restored on unmount.
  useEffect(() => {
    if (process.stdout.isTTY) process.stdout.write(BRACKET_PASTE_ON);
    return () => { if (process.stdout.isTTY) process.stdout.write(BRACKET_PASTE_OFF); };
  }, []);

  // For a LOCAL provider (LM Studio), follow what the server ACTUALLY has loaded:
  // auto-select the loaded model if the configured one isn't loaded (so freecode
  // doesn't cling to a stale id), and size compaction to that model's real loaded
  // context — warning loudly if freecode's prompt+tools already crowd the window.
  useEffect(() => {
    let cancelled = false;
    detectedWindowRef.current = null;
    setServerLabel(null);
    (async () => {
      if (!["ollama", "lmstudio", "llama-server"].includes(config.provider)) return;
      // Relabel: a llama.cpp server reached via the lmstudio provider (or any
      // local-server provider whose endpoint is a different kind) shows its REAL
      // kind in the status line — "llama-server", not "lmstudio".
      const kind = await detectServerKind(config.baseUrl ?? undefined);
      if (cancelled) return;
      if (kind && kind !== config.provider) setServerLabel(kind);

      // llama.cpp server: no per-model API, but /props reports the loaded n_ctx —
      // so freecode sizes compaction to the REAL window (e.g. 256K) instead of
      // guessing 128K from the model name. Works even via the lmstudio provider.
      if (kind === "llama-server" || config.provider === "llama-server") {
        const win = await detectLlamaServerContext(config.baseUrl ?? undefined);
        if (cancelled || !win) return;
        detectedWindowRef.current = win;
        trackerRef.current.setWindow(win);
        setCtxFill(trackerRef.current.contextFill());
        // Sizing compaction to the real /props window is a background detail — don't
        // narrate it into the CLI on every connect (it was noisy and double-printed
        // on the async re-fire). Diagnostics go to the debug log instead.
        debug.log(`llama-server /props: ${win}-token context detected; compaction sized to that`);
        return;
      }

      const loaded = await detectLocalModels(config.provider, config.baseUrl);
      if (cancelled || loaded.length === 0) return;
      const chosen = loaded.find((m) => m.id === model) ?? loaded[0]!;
      detectedWindowRef.current = chosen.contextLength;
      if (chosen.contextLength) { trackerRef.current.setWindow(chosen.contextLength); setCtxFill(trackerRef.current.contextFill()); }
      const key = `${config.provider}:${chosen.id}:${chosen.contextLength}`;
      if (lastLocalDetectRef.current === key) return; // already handled this state
      lastLocalDetectRef.current = key;
      if (chosen.id !== model) {
        // The configured model isn't loaded — use what LM Studio is actually serving.
        setModel(chosen.id);
        trackerRef.current.setPricing(priceFor(chosen.id, config.provider));
        writeLastSession({ provider: config.provider, model: chosen.id, baseUrl: config.baseUrl }, undefined, process.cwd());
        setMessages((prev) => [...prev, { id: `lm-${Date.now()}`, role: "system", text: `${config.provider}: "${model}" isn't loaded — switched to the loaded model "${chosen.id}".` }]);
      }
      if (chosen.contextLength) {
        const sysTok = Math.ceil(toolListToSystemPrompt(tools).length / 4);
        const toolTok = Math.ceil(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters ?? zodToJsonSchema(t.schema) }))).length / 4);
        const overhead = sysTok + toolTok;
        const tight = overhead + 1024 > chosen.contextLength;
        if (tight) {
          // A near-full window is a real problem the user must act on — keep this visible.
          setMessages((prev) => [...prev, { id: `ctx-${Date.now()}`, role: "warning", text:
            `${config.provider} loaded "${chosen.id}" with only a ${chosen.contextLength!.toLocaleString()}-token context, but freecode's prompt + tools need ~${overhead.toLocaleString()} — almost no room to respond. Raise its Context Length in ${config.provider}.` }]);
        } else {
          // Routine sizing is a background detail, not CLI chatter.
          debug.log(`${config.provider}: "${chosen.id}" ${chosen.contextLength}-token context detected; compaction sized to that`);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.provider, config.baseUrl, model]);

  // Ollama has no per-model API like LM Studio, but /api/ps reports the num_ctx a
  // model is actually LOADED with — often far below the name-based guess (a qwen
  // name → 128k while it's loaded at 65k). Size the context meter + compaction to
  // that. Keyed on `busy` too because Ollama loads the model lazily on the first
  // request, so the real size isn't known until a turn has hit it once; re-reading
  // when the turn ends (busy→idle) catches it. Cheap and idempotent.
  useEffect(() => {
    if (config.provider !== "ollama" || busy) return;
    let cancelled = false;
    (async () => {
      const win = await detectOllamaContext(config.baseUrl, model);
      if (cancelled || !win || detectedWindowRef.current === win) return;
      detectedWindowRef.current = win;
      trackerRef.current.setWindow(win);
      setCtxFill(trackerRef.current.contextFill());
      debug.log(`ollama /api/ps: ${win}-token context for "${model}"`);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.provider, config.baseUrl, model, busy]);

  // Flush finished messages into <Static> so the cursor-managed (repainting)
  // region stays SMALL. When idle, every message is final → settle all. DURING a
  // turn, settle everything except the LAST message (the only one that can still
  // mutate — streaming appends to it; tool calls/results arrive as new, immutable
  // messages). Previously `settled` froze at turn start, so the whole in-flight
  // turn piled up in the dynamic region; once it grew taller than the window,
  // each 90ms repaint's cursor-up overshot into the scrollback and yanked the
  // terminal to the top (the logo) — which also made text selection/copy
  // impossible. Keeping the region ~1 message tall stops the overshoot. Never
  // move settled backwards (Static is append-only).
  useEffect(() => {
    if (!busy && !pending) setSettled(messages.length);
    else setSettled((s) => Math.max(s, Math.max(0, messages.length - 1)));
  }, [busy, pending, messages.length]);

  // Reset the <Static> mount once the live window exceeds STATIC_WINDOW: bump the
  // epoch (remounts Static, so Ink releases the render trees of scrolled-off
  // messages) and jump `staticBase` to the current settled count so the fresh
  // mount starts empty and nothing re-prints — the earlier lines are already in
  // the terminal's scrollback. This is what keeps a marathon session's heap flat.
  useEffect(() => {
    if (settled - staticBase > STATIC_WINDOW) {
      setStaticBase(settled);
      setStaticEpoch((e) => e + 1);
    }
  }, [settled, staticBase]);

  // Wholesale-replacing the transcript (/new clears it, /resume swaps in a restored
  // one) makes messages.length JUMP DOWN. Ink's <Static> only advances its internal
  // write-index when items.length GROWS, so without a remount its stale high index
  // swallows every message of the new/restored transcript until the count climbs
  // back past the old length — the screen looks frozen. Remounting (fresh epoch) with
  // base 0 gives Static a clean index that renders the new transcript from the top.
  function resetStaticWindow(): void {
    setStaticBase(0);
    setStaticEpoch((e) => e + 1);
    setSettled(0);
  }

  // Drain queued input once the turn finishes (and no approval is open). One at a
  // time: dispatching sets busy again, which re-runs this effect for the next.
  useEffect(() => {
    // Never drain while a turn OR a /goal loop is active — draining mid-goal (e.g.
    // during the verify window, when `busy` briefly renders false) would start a
    // second runAgentLoop concurrently, and the two would clobber conversationRef/
    // streamIdRef/abortRef. `queuedCount` in the deps re-fires the drain after a
    // synchronous slash command (which doesn't toggle busy), and `goalActive` (state)
    // re-fires it the moment a goal ends — so queued input never strands.
    if (busy || pending || goalActive) return;
    if (queuedInputRef.current.length === 0) return;
    const next = queuedInputRef.current.shift()!;
    setQueuedCount(queuedInputRef.current.length);
    // Already echoed + persisted at enqueue (skipEcho) — just run it.
    if (next.startsWith("/")) void runSlash(next);
    else if (next.startsWith("!")) void runBang(next, { skipEcho: true });
    else void submit(next, { skipEcho: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, pending, goalActive, queuedCount]);

  // Honor reduced-motion: FREECODE_NO_ANIMATION / NO_ANIMATION → static indicators
  // instead of the spinner/eye animation (the CLI analog of prefersReducedMotion).
  const reducedMotion = process.env.FREECODE_NO_ANIMATION === "1" || process.env.NO_ANIMATION === "1";

  // Startup splash: <Static> can't animate (it writes once), so Bubo darts his
  // gaze in the dynamic region for a beat at launch, then `introReady` flips and
  // the frozen half-size intro (eyes centered) is committed to scrollback.
  // Reduced motion skips straight to it.
  const [introReady, setIntroReady] = useState(false);
  const [eyeTick, setEyeTick] = useState(0);
  useEffect(() => {
    if (reducedMotion) { setIntroReady(true); return; }
    const id = setInterval(() => setEyeTick((t) => t + 1), 220);
    const settle = setTimeout(() => { clearInterval(id); setIntroReady(true); }, 3000);
    return () => { clearInterval(id); clearTimeout(settle); };
  }, [reducedMotion]);
  // A look-around cycle: center → right → center → left, by eye-cell offset.
  const EYE_DART = [0, 1, 2, 1, 0, -1, -2, -1];
  const introEye = introReady ? 0 : (EYE_DART[eyeTick % EYE_DART.length] ?? 0);

  // One clock while a turn runs: ticks the spinner (~90ms) and, every few ticks,
  // Bubo's eyes; also marks the start so we can show elapsed time. Skipped under
  // reduced motion (we still mark the start for the elapsed counter).
  useEffect(() => {
    if (!busy) { setTick(0); return; }
    busyStartRef.current = Date.now();
    lastActivityRef.current = Date.now(); // a fresh turn starts "healthy"
    if (reducedMotion) return;
    const id = setInterval(() => setTick((t) => t + 1), 90);
    return () => clearInterval(id);
  }, [busy, reducedMotion]);

  // Crawl watchdog: the idle stall-timeout can't catch a stream that trickles
  // (e.g. 0.2 tok/s on a throttled/overloaded endpoint or a huge prompt) — bytes
  // keep arriving so it never looks silent, yet the turn can run for ~half an hour
  // doing nothing useful. Surface ONE visible warning per turn when a generation
  // burst has crawled (<2 tok/s) for over a minute, so it's never a mystery hang.
  useEffect(() => {
    if (!busy) { crawlWarnedRef.current = false; return; }
    const id = setInterval(() => {
      const start = burstStartRef.current;
      if (!start || crawlWarnedRef.current) return;
      const burstMs = Date.now() - start;
      if (burstMs < 60_000) return;
      const tps = tokensPerSecond(estTokens(burstCharsRef.current), burstMs);
      if (tps > 0 && tps < 2) {
        crawlWarnedRef.current = true;
        setMessages((prev) => [...prev, { id: `crawl-${Date.now()}`, role: "warning", text:
          `⚠ Generating very slowly — ${formatSpeed(tps)} for ${Math.floor(burstMs / 1000)}s. The endpoint may be throttling or at capacity, or the prompt/output is very large. Press esc to interrupt, then try /model to switch or /compact to shrink the context.` }]);
      }
    }, 5_000);
    return () => clearInterval(id);
  }, [busy]);


  // Startup update check: npm installs only, throttled to ~daily, silent on any
  // failure. A one-line nudge when a newer version is published — so a run-only
  // machine can't unknowingly sit on stale code (which is exactly how the old
  // auto-`git pull` clone model failed, silently, for days).
  useEffect(() => {
    void (async () => {
      try {
        const latest = await checkForUpdate();
        if (latest) setMessages((prev) => [...prev, { id: "update-notice", role: "system",
          text: `${ICON.update} freecode ${latest} is available (you have ${baseVersion(VERSION)}) — run: ${UPDATE_HINT}` }]);
      } catch { /* never let the update check disrupt startup */ }
    })();
  }, []);

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
    const events = readSession(s);
    // Restore the REAL provider-format context (tool calls + results, plus any
    // compaction summary) if it was persisted; fall back to the text-only rebuild
    // for sessions saved before conversation-state existed.
    conversationRef.current = readConversationState(s) ?? historyFromEvents(events);
    applyTabTitle(titleOf(events));
    // Restore the up/down input history so a resumed session can recall what you typed.
    historyRef.current = inputHistoryFromEvents(events);
    historyIdxRef.current = null; setHistoryIdx(null);
    draftRef.current = "";
    resetStaticWindow(); // swap in the restored transcript → remount Static so it renders from the top
    setMessages([...restoredMessagesFromEvents(events, s.id), { id: `s-${Date.now()}`, role: "system", text: `Resumed (${conversationRef.current.length} messages of context)` }]);
  }

  // (Re)point the cross-session memory store at a session id and recall what the
  // shared store already knows about this user. Flushes the previous session's
  // queued turns first. Fail-soft: a down/slow Honcho just yields no memory.
  function setupMemory(sessionId: string): void {
    const prev = memoryRef.current;
    if (prev) void prev.flush();
    const mem = config.memory;
    const store = createMemoryStore({
      enabled: mem?.enabled ?? false,
      baseUrl: mem?.baseUrl,
      workspace: mem?.workspace ?? "freecode",
      peer: mem?.peer ?? "user",
      apiKey: mem?.apiKey,
      sessionId,
    });
    memoryRef.current = store;
    if (!store.enabled) return;
    void (async () => {
      const block = await store.recall();
      const st = await store.status();
      let text: string;
      if (!st.reachable) {
        text = `${ICON.memory} memory: Honcho unreachable at ${mem?.baseUrl} — running without persistent memory this session`;
      } else if (block) {
        text = `${ICON.memory} memory: recalled ${st.representationChars} chars from prior sessions${st.cached ? " (cached — Honcho didn't respond this time)" : ""} (workspace ${st.workspace})`;
      } else {
        text = `${ICON.memory} memory: connected to Honcho (workspace ${st.workspace}) — nothing recalled yet; this session will add to it`;
      }
      setMessages((prev) => [...prev, { id: `mem-${Date.now()}`, role: "system", text }]);
    })();
  }

  // Flush any queued memory turns when the REPL unmounts (quit).
  useEffect(() => () => { void memoryRef.current?.flush(); }, []);

  const promptUser: ApprovalCallback = (req) => approvalQueue.enqueue(req);

  useEffect(() => {
    const cwd = process.cwd();
    if (resumeId) {
      const s = resumeSession(cwd, resumeId);
      if (!s) {
        setErrorLine(`No such session: ${resumeId}`);
        sessionRef.current = newSession(cwd);
      } else {
        doResume(s);
      }
    } else {
      sessionRef.current = newSession(cwd);
    }
    // Title from the session's name if it has one (resume), else the project folder.
    applyTabTitle(titleOf(readSession(sessionRef.current) as never));
    // Point cross-session memory at this session and recall the user's history.
    setupMemory(sessionRef.current.id);
    // Remember this session's provider/model so the next launch reopens here.
    writeLastSession({ provider: config.provider, model, baseUrl: config.baseUrl }, undefined, process.cwd());
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

  async function submit(prompt: string, opts?: { skipEcho?: boolean; override?: { provider: ReturnType<typeof buildProvider>; model: string; providerId: string } }): Promise<{ text: string; aborted: boolean; toolCalls: number }> {
    if (!prompt.trim() || busy) return { text: "", aborted: false, toolCalls: 0 };
    // A consult runs this same turn machinery but with a DIFFERENT provider/model
    // (the supervisor) and always as a full agent — never gated by plan mode.
    const ov = opts?.override;
    const aProvider = ov?.provider ?? provider;
    const aModel = ov?.model ?? model;
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
    // Queued input was already shown as a user message + persisted at enqueue
    // time (so it appears in history in the order it was typed); don't echo twice.
    if (!opts?.skipEcho) {
      setMessages((prev) => [...prev, { id, role: "user", text: prompt + (attachSuffix ? `  [${attachSuffix} attached]` : "") }]);
      appendEvent(sessionRef.current, { kind: "user", text: prompt, ts: new Date().toISOString() });
    }
    // Feed the turn to cross-session memory (once per submit, incl. queued input).
    memoryRef.current?.record("user", prompt);
    if (failed.length) setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: failed.join("\n") }]);
    let buffer = "";
    let streamedAny = false;
    let aborted = false;
    let toolCallsThisRun = 0; // real progress signal for /goal (did this cycle act?)
    let sawUsage = false; // did the provider report token usage? if not, we estimate ctx
    let degenerated: string | null = null; // set if the stream collapses into repetition
    let degenCheckedAt = 0; // throttle the (cheap but not free) repetition scan
    const t0 = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;
    streamIdRef.current = null;
    burstCharsRef.current = 0;
    burstStartRef.current = null;
    genCharsRef.current = 0;
    genMsRef.current = 0;
    // Coalesced-streaming state (see pendingAnswerRef): flush accumulated deltas
    // into the assistant/reasoning bubbles in ONE setMessages, at most ~30fps.
    pendingAnswerRef.current = "";
    pendingThinkRef.current = "";
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    let bubbleSeq = 0;
    const flushStream = (): void => {
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      const think = pendingThinkRef.current;
      const answer = pendingAnswerRef.current;
      if (!think && !answer) return;
      pendingThinkRef.current = "";
      pendingAnswerRef.current = "";
      const plan = planStreamFlush(
        { thinkId: thinkIdRef.current, answerId: streamIdRef.current },
        { think, answer },
        (kind) => `${kind === "reasoning" ? "think" : "a"}-${t0}-${bubbleSeq++}`,
      );
      // Commit the chosen ids to refs SYNCHRONOUSLY, before setMessages, so the
      // tool_call handler's `streamIdRef.current = null` can't be undone by a
      // batched updater running later.
      thinkIdRef.current = plan.thinkId;
      streamIdRef.current = plan.answerId;
      setMessages(plan.apply);
    };
    // ~30fps: comfortably below any terminal's useful refresh, far above the
    // per-token rate that caused the leak. A trailing timer, so the last tokens
    // of a burst always land even if no further delta arrives to reschedule.
    const scheduleFlush = (): void => {
      if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushStream, 33);
    };
    try {
      // Plan mode: read-only tools (permission=safe) + a plan-only system prompt.
      // A consult is always a full agent — plan mode doesn't restrict the supervisor.
      const effPlan = planMode && !ov;
      const baseTools = effPlan ? tools.filter((t) => t.permission === "safe") : tools;
      // Tools hidden by plan mode — so a call to one gets a clear "read-only" note.
      const restrictedToolNames = effPlan ? tools.filter((t) => t.permission !== "safe").map((t) => t.name) : [];
      // Sub-agents (Tier A): offer the Agent tool outside plan mode. The getter
      // reads the live provider/model so a mid-session switch is honoured; the
      // sub-agent's toolset is baseTools (no Agent) — recursion-safe by design.
      const activeTools = effPlan
        ? baseTools
        : [...baseTools, createAgentTool(() => ({
            provider: aProvider, model: aModel, tools: baseTools, permission, promptUser,
            hooks: config.hooks, contextWindow: windowFor(aModel),
            // Live sub-agent progress: render each interior tool call as a dim,
            // indented line so a long sub-agent run visibly moves (no frozen
            // spinner until the final report).
            onProgress: (line: string) => {
              streamIdRef.current = null; // the next assistant text starts a fresh bubble
              setMessages((prev) => [...prev, { id: `sap-${Date.now()}-${prev.length}`, role: "system", text: `     ${line}` }]);
            },
          }))];
      const systemPrompt = effPlan ? toolListToSystemPrompt(activeTools) + PLAN_MODE_NOTE : undefined;
      // Auto-verify gate: skip in plan mode (nothing changes) and on a consult (the
      // supervisor verifies on its own terms). on = quick checks; strict = full.
      const vmode = effPlan || ov ? "off" : config.verifyMode;
      const verifyPlan = vmode === "strict" ? resolveVerify(process.cwd(), config.verify)
        : vmode === "on" ? resolveQuickVerify(process.cwd())
        : undefined;
      const result = await runAgentLoop({
        provider: aProvider,
        tools: activeTools,
        systemPrompt,
        model: aModel,
        maxTurns: config.maxTurns,
        prompt: effectivePrompt,
        images,
        history: conversationRef.current,
        contextWindow: windowFor(aModel),
        // The server can reject with its REAL usable window (llama.cpp /props
        // overstates it). Remember what the loop learned so later turns — and the
        // ctx gauge — size to the truth instead of re-tripping the same 400.
        onContextLimit: (n) => { detectedWindowRef.current = n; trackerRef.current.setWindow(n); setCtxFill(trackerRef.current.contextFill()); },
        contextThreshold: config.contextThreshold,
        enablePromptCache: config.enablePromptCache,
        enableExtendedThinking: config.enableExtendedThinking,
        hooks: config.hooks,
        restrictedToolNames,
        verifyPlan,
        verifyMode: vmode,
        memoryContext: memoryRef.current?.context(),
        permission,
        promptUser,
        signal: controller.signal,
        onEvent: (e) => {
          lastActivityRef.current = Date.now(); // any event = the stream is alive (health colour)
          // Before handling any DISCRETE event (tool call/result, usage, ledger,
          // …), flush the buffered stream text so the assistant bubble is complete
          // and ordered ahead of whatever the discrete event appends.
          if (e.type !== "thinking_delta" && e.type !== "text_delta") flushStream();
          // Speedometer: count every produced char (reasoning + answer) and start
          // the clock on the first token of this generation burst.
          if ((e.type === "thinking_delta" || e.type === "text_delta") && e.text) {
            if (burstStartRef.current === null) burstStartRef.current = Date.now();
            burstCharsRef.current += e.text.length;
            genCharsRef.current += e.text.length;
          }
          if (e.type === "thinking_delta" && e.text) {
            // Reasoning channel (gpt-oss et al.) — stream into a dim 💭 bubble so
            // you can see the model actually working through the problem. Buffered;
            // flushStream creates/appends the bubble at ~30fps.
            pendingThinkRef.current += e.text;
            scheduleFlush();
          } else if (e.type === "text_delta" && e.text) {
            buffer += e.text;
            streamedAny = true;
            // Degeneration guard: if the model collapses into runaway repetition,
            // abort the turn instead of streaming garbage until the user hits esc.
            if (!degenerated && buffer.length - degenCheckedAt >= 400) {
              degenCheckedAt = buffer.length;
              const reason = degenerationReason(buffer);
              if (reason) {
                degenerated = reason;
                controller.abort();
                return;
              }
            }
            // Buffered; flushStream closes the reasoning bubble and creates/appends
            // the assistant bubble at ~30fps (decoupled from the token rate).
            pendingAnswerRef.current += e.text;
            scheduleFlush();
          } else if (e.type === "tool_call" && e.call) {
            toolCallsThisRun += 1;
            streamIdRef.current = null; // text after a tool call starts a fresh bubble
            thinkIdRef.current = null; // and a fresh reasoning bubble next step
            if (burstStartRef.current !== null) genMsRef.current += Date.now() - burstStartRef.current; // bank this burst's gen time
            burstCharsRef.current = 0; burstStartRef.current = null; // new burst → reset the speedometer
            const call = e.call;
            const tid = `t-${call.id ?? Math.random().toString(36).slice(2, 8)}`;
            setMessages((prev) => [...prev, { id: tid, role: "tool", text: `${ICON.toolCall} ${call.name}(${JSON.stringify(call.arguments).slice(0, 120)})`, toolName: call.name }]);
            appendEvent(sessionRef.current, { kind: "tool_call", id: call.id ?? tid, name: call.name, args: call.arguments, ts: new Date().toISOString() });
          } else if (e.type === "tool_result" && e.result) {
            const r = e.result;
            const rid = r.id ?? Math.random().toString(36).slice(2, 8);
            const tid = `r-${rid}`;
            setMessages((prev) =>
              prev
                .map((m) => (m.id === `t-${rid}` ? { ...m, text: m.text + (r.ok ? ` ${ICON.ok}` : ` ${ICON.fail}`) } : m))
                .concat([{ id: tid, role: "tool", text: previewToolResult(r.output), toolName: "result", ok: r.ok }]),
            );
            appendEvent(sessionRef.current, { kind: "tool_result", id: rid, output: r.output, ok: r.ok, durationMs: r.durationMs, ts: new Date().toISOString() });
          } else if (e.type === "usage" && e.usage) {
            if (e.usage.input || e.usage.output) sawUsage = true;
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
            if (L.verified.length) lines.push(`${ICON.ok} verified  ${L.verified.join("; ")}`);
            if (L.observed.length) lines.push(`· observed  ${L.observed.join("; ")}`);
            if (L.believed.length) lines.push(`~ believed  ${L.believed.join("; ")}`);
            if (lines.length) setMessages((prev) => [...prev, { id: `led-${Date.now()}-${prev.length}`, role: "ledger", text: lines.join("\n") }]);
          } else if (e.type === "error" && e.error) {
            setErrorLine(e.error);
          }
        },
      });
      flushStream(); // drain any tail tokens the last event didn't trigger a flush for
      conversationRef.current = result.messages; // carry full context into the next turn
      writeConversationState(sessionRef.current, result.messages); // …and to disk, so /resume restores it in full
      // Show ctx for EVERY provider — some (local servers, certain gateways) don't
      // report token usage, leaving the gauge at 0. Estimate it from the
      // conversation + system prompt so the bar always reflects reality.
      if (!sawUsage) {
        const est = estimateMessagesTokens(conversationRef.current, toolListToSystemPrompt(tools));
        setCtxTokens(est);
        setCtxFill(Math.min(1, est / Math.max(1, trackerRef.current.window())));
      }
      // Text was streamed live into assistant bubbles; only push a fallback
      // message if the provider produced text without streaming events.
      if (!streamedAny && buffer) {
        setMessages((prev) => [...prev, { id: `a-${t0}`, role: "assistant", text: buffer }]);
      }
      appendEvent(sessionRef.current, { kind: "assistant", text: buffer, ts: new Date().toISOString(), usage: result.usage as unknown as Record<string, number> });
      memoryRef.current?.record("assistant", buffer);
      void memoryRef.current?.flush(); // end of turn: persist the pair now (survives a quick quit)
      // Persistent speedometer: bank the final burst's time, then show the run's
      // generation throughput as a dim line that stays in the transcript (the
      // live "Working…" readout vanishes when the turn ends).
      if (burstStartRef.current !== null) { genMsRef.current += Date.now() - burstStartRef.current; burstStartRef.current = null; }
      const genSpeed = formatSpeed(tokensPerSecond(estTokens(genCharsRef.current), genMsRef.current));
      if (genSpeed) setMessages((prev) => [...prev, { id: `spd-${t0}`, role: "system", text: `${ICON.bolt} ${genSpeed} (generation)` }]);
      debug.log("turn complete", { turns: result.turns, usage: result.usage });
    } catch (err) {
      flushStream(); // preserve whatever streamed before the error/abort
      if (degenerated) {
        aborted = true; // mark aborted so any /goal loop also halts (re-running would re-collapse)
        setMessages((prev) => [...prev, { id: `deg-${Date.now()}`, role: "system", text:
          `⚠ Stopped: the model's output collapsed into runaway repetition (${degenerated}). ` +
          "This is a model-side failure, not your prompt — retry, or switch models with /model." }]);
      } else if (controller.signal.aborted) {
        aborted = true;
        setMessages((prev) => [...prev, { id: `int-${Date.now()}`, role: "system", text: `${ICON.stop} Interrupted.` }]);
      } else {
        setErrorLine(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      abortRef.current = null;
      setBusy(false);
    }
    return { text: buffer, aborted, toolCalls: toolCallsThisRun };
  }

  // The picker's model list, fetched LIVE each call (no cache): prefer the rich
  // catalog — which drops models the provider marked expired and floats free ones
  // by ACTUAL pricing — when the provider exposes one; otherwise the bare id list
  // with the name-based free-first fallback.
  async function modelListFor(prov: ReturnType<typeof buildProvider>): Promise<string[]> {
    const infos = prov.modelCatalog ? await prov.modelCatalog() : [];
    if (infos.length) return orderChatModels(infos);
    const all = await prov.models();
    const { show } = filterChatModels(all);
    return sortFreeFirst(show.length ? show : all);
  }

  // Open the interactive model picker for a given provider instance. Shared by
  // /model (no arg) and by /provider (which auto-opens it for the new provider).
  async function openModelPicker(prov: ReturnType<typeof buildProvider>, currentModel: string): Promise<void> {
    setBusy(true);
    try {
      const list = await modelListFor(prov);
      if (!list.length) { setErrorLine("Provider returned no models."); return; }
      const cur = list.indexOf(currentModel);
      setModelPicker({ all: list, query: "", idx: cur >= 0 ? cur : 0 });
    } catch (err) {
      setErrorLine(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // /consult stage 2: resolve the chosen provider's config (key/baseUrl/model
  // from vault + settings, leaving the SESSION's provider untouched) and fetch a
  // fresh model list, then open the model stage of the consult picker.
  async function consultPickProvider(providerId: string, task: string): Promise<void> {
    setBusy(true);
    try {
      const cfg = loadConfig({ flags: { ...(flags ?? {}), provider: providerId as CliFlags["provider"] } });
      const list = await modelListFor(buildProvider(cfg));
      if (!list.length) { setErrorLine(`${providerId} returned no models (no key, or endpoint unreachable).`); setConsultPicker(null); return; }
      const cur = list.indexOf(cfg.model);
      setConsultPicker({ stage: "model", task, providerId, cfg, all: list, query: "", idx: cur >= 0 ? cur : 0 });
    } catch (err) {
      setErrorLine(err instanceof Error ? err.message : String(err));
      setConsultPicker(null);
    } finally {
      setBusy(false);
    }
  }

  // /scan: switch the live session to a discovered server. The endpoint + model
  // are passed as flags so loadConfig resolves them with highest precedence; the
  // choice is persisted (writeLastSession) so it survives a relaunch. For a
  // llama-server we trust the /props-detected context window over the name table.
  function applyDiscoveredServer(server: DiscoveredServer, chosenModel: string): void {
    const providerId = server.kind === "ollama" ? "ollama" : "llama-server";
    const newCfg = loadConfig({
      flags: { ...(flags ?? {}), provider: providerId as CliFlags["provider"], baseUrl: server.baseUrl, model: chosenModel || undefined },
    });
    setConfig(newCfg);
    setModel(newCfg.model);
    trackerRef.current.setPricing(priceFor(newCfg.model, newCfg.provider));
    trackerRef.current.setWindow(server.contextLength ?? contextWindowFor(newCfg.model));
    setCtxFill(trackerRef.current.contextFill());
    writeLastSession({ provider: newCfg.provider, model: newCfg.model, baseUrl: newCfg.baseUrl }, undefined, process.cwd());
    const ctx = server.contextLength ? ` · ${server.contextLength.toLocaleString()}-token ctx` : "";
    setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text:
      `Switched to ${providerId} @ ${server.endpoint} — model ${newCfg.model}${ctx}. Active from your next message.${chosenModel ? "" : "\n(no model list was available — set one with /model if this isn't right.)"}` }]);
  }

  // /consult final: run the supervisor as a full-agent turn with the chosen
  // provider/model, seeded with the conversation so far; its turn threads back
  // into the conversation (submit sets conversationRef), so the primary agent
  // sees the review on its next message.
  async function startConsult(cfg: ResolvedConfig, supModel: string, task: string): Promise<void> {
    const supProvider = buildProvider({ ...cfg, model: supModel });
    setMessages((prev) => [...prev, { id: `cons-${Date.now()}`, role: "system", text: consultBanner(cfg.provider, supModel, task) }]);
    const baseLen = conversationRef.current.length; // session BEFORE the consult
    const { text } = await submit(supervisorPrompt(task), { skipEcho: true, override: { provider: supProvider, model: supModel, providerId: cfg.provider } });
    // Re-thread the consult: replace the supervisor's framing + raw turns with one
    // clearly-attributed note, so the PRIMARY model sees the review as EXTERNAL
    // feedback rather than absorbing the "you are a supervisor" framing as its own
    // instructions. (The UI already showed the supervisor's full work live.)
    conversationRef.current = [
      ...conversationRef.current.slice(0, baseLen),
      { role: "user", content: `[A separate supervisor model — ${cfg.provider}:${supModel} — was consulted with the task: "${task}". Its review follows. Treat it as external feedback; any file changes it made are already on disk.]\n\n${text.trim() || "(the supervisor returned no text)"}` },
    ];
    setMessages((prev) => [...prev, { id: `cons-end-${Date.now()}`, role: "system", text: `${ICON.eye} Supervisor (${cfg.provider}:${supModel}) finished — its review is threaded into the conversation for the primary agent.` }]);
  }

  // `!<cmd>`: run a shell command yourself, right here — no agent, no round-trip.
  // You typed it, so it skips the tool-approval prompt, but the Bash tool's
  // deny-list safety net still applies. The output is shown AND fed into the
  // model's context (like Claude Code's `!`), so the next turn can act on it.
  async function runBang(line: string, opts?: { skipEcho?: boolean }): Promise<void> {
    const command = line.replace(/^!/, "").trim();
    if (!command) { setErrorLine(`Usage: !<command> — runs it in ${bashShellName()} and shows the output here.`); return; }
    const bash = tools.find((t) => t.name === "Bash") as Tool<{ command: string }> | undefined;
    if (!bash) { setErrorLine("The Bash tool isn't available in this session, so `!` can't run."); return; }
    if (!opts?.skipEcho) {
      setMessages((prev) => [...prev, { id: `bang-${Date.now()}`, role: "user", text: `! ${command}` }]);
      appendEvent(sessionRef.current, { kind: "user", text: `! ${command}`, ts: new Date().toISOString() });
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const r = await bash.run({ command }, { cwd: process.cwd(), signal: controller.signal });
      const body = (r.output ?? "").trim();
      const shown = body || (r.ok ? "(no output)" : (r.error ?? "(command failed)"));
      setMessages((prev) => [...prev, { id: `bangout-${Date.now()}`, role: "tool", text: shown, toolName: "result", ok: r.ok }]);
      // Make the result visible to the model next turn — bounded so a huge dump
      // can't blow the context window.
      const forCtx = body.length > 4_000 ? `${body.slice(0, 4_000)}\n…(truncated)` : body;
      conversationRef.current = [...conversationRef.current, {
        role: "user",
        content: `[I ran a shell command myself]\n$ ${command}\n\n${r.ok ? "Output:" : `Failed (${r.error ?? "error"}):`}\n${forCtx || "(no output)"}`,
      }];
    } catch (err) {
      setErrorLine(`! ${(err as Error).message}`);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  async function runSlash(cmd: string): Promise<void> {
    const [name, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(" ");
    // Echo the command into history so you can see what you ran — it's your
    // input, and without this a slash command left no trace of itself.
    setMessages((prev) => [...prev, { id: `cmd-${Date.now()}-${prev.length}`, role: "user", text: cmd }]);
    switch (name) {
      case "/models": // alias
      case "/model": {
        if (arg) {
          setModel(arg);
          trackerRef.current.setPricing(priceFor(arg, config.provider));
          trackerRef.current.setWindow(contextWindowFor(arg));
          setCtxFill(trackerRef.current.contextFill());
          writeLastSession({ provider: config.provider, model: arg, baseUrl: config.baseUrl }, undefined, process.cwd());
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Model switched to ${arg} (provider: ${config.provider}). Active from your next message.` }]);
        } else {
          // No arg: open the interactive arrow-key picker (↑/↓ select, type to
          // filter, Enter switch). `/model <name>` above still switches directly.
          await openModelPicker(provider, model);
        }
        break;
      }
      case "/new": {
        const cwd = process.cwd();
        sessionRef.current = newSession(cwd);
        setupMemory(sessionRef.current.id); // new freecode session → new Honcho session (same user memory)
        conversationRef.current = [];
        applyTabTitle(); // fresh session → back to the project-folder title
        setMessages([]);
        resetStaticWindow(); // clear the transcript → remount Static so new lines aren't swallowed
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
          if (s) { doResume(s); setupMemory(s.id); }
          else setErrorLine(`No such session: ${arg}`);
        }
        break;
      }
      case "/rename": {
        if (!arg.trim()) {
          setErrorLine("Usage: /rename <name>");
        } else {
          setSessionTitle(sessionRef.current, arg.trim());
          applyTabTitle(arg.trim());
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
          `maxTurns     ${config.maxTurns > 0 ? config.maxTurns : "off (uncapped)"}`,
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
        const local = ["ollama", "lmstudio", "llama-server", "mock"].includes(config.provider);
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
      case "/goal": {
        const sub = arg.trim();
        if (sub === "stop") {
          if (goalActiveRef.current) {
            goalActiveRef.current = false; setGoalActive(false);
            abortRef.current?.abort(); // interrupt the in-flight cycle too
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `${ICON.goal} Goal stopped.` }]);
          } else {
            setErrorLine("No goal is running.");
          }
          break;
        }
        if (!sub) {
          setErrorLine("Usage: /goal <objective>  — work autonomously until done (/goal stop or esc to halt)");
          break;
        }
        if (goalActiveRef.current) {
          setErrorLine("A goal is already running. /goal stop to halt it first.");
          break;
        }
        const objective = sub;
        const max = goalMax();          // 0 = uncapped (default)
        const uncapped = max <= 0;
        // A claimed DONE is GATED on the project's real checks — not the model's
        // word. Resolved once; if there are none, DONE stays unverified (and says so).
        const verifyPlan = resolveVerify(process.cwd(), config.verify);
        goalActiveRef.current = true; setGoalActive(true);
        setMessages((prev) => [...prev, { id: `goal-${Date.now()}`, role: "system", text:
          `${ICON.goal} Goal: ${objective}\n  ${uncapped ? "Working autonomously until done (no cycle cap). " : `Working autonomously (up to ${max} cycles). `}` +
          (verifyPlan.source === "none"
            ? "No verify command configured — DONE will be the model's word, unverified."
            : `DONE is verified with: ${verifyPlan.commands.join(" && ")}.`) +
          "\n  Press esc or run /goal stop to halt." }]);
        try {
          let completed = 0;
          let verifyFails = 0;  // times the model claimed DONE but the checks failed
          let noProgress = 0;   // consecutive cycles that used no tool (just talked)
          const MAX_VERIFY_FAILS = 3;
          const MAX_NO_PROGRESS = 2;
          let pendingFailure: { failedCommand: string; output: string } | null = null;
          while (goalActiveRef.current) {
            setMessages((prev) => [...prev, { id: `gc-${Date.now()}`, role: "system", text: uncapped ? `${ICON.goal} cycle ${completed + 1}` : `${ICON.goal} cycle ${completed + 1}/${max}` }]);
            const prompt = pendingFailure
              ? goalVerifyFailedPrompt(objective, pendingFailure.failedCommand, pendingFailure.output)
              : goalPrompt(objective, completed);
            pendingFailure = null;
            const res = await submit(prompt);
            completed += 1;
            if (res.aborted) {
              setMessages((prev) => [...prev, { id: `gd-${Date.now()}`, role: "system", text: `${ICON.goal} Goal halted after ${completed} cycle${completed === 1 ? "" : "s"}.` }]);
              break;
            }
            const status = goalStatus(res.text);

            if (status === "done") {
              if (verifyPlan.source === "none") {
                setMessages((prev) => [...prev, { id: `gd-${Date.now()}`, role: "warning", text:
                  `✓ Model reports DONE after ${completed} cycle${completed === 1 ? "" : "s"} — but there's no verify command, so this is UNVERIFIED (its word, not checked). Add a \`verify\` command to gate future goals.` }]);
                break;
              }
              setMessages((prev) => [...prev, { id: `gv-${Date.now()}`, role: "system", text: `${ICON.goal} Model reports DONE — verifying: ${verifyPlan.commands.join(" && ")}…` }]);
              const v = await runVerify(verifyPlan, process.cwd());
              if (!goalActiveRef.current) break; // stopped during verification
              if (v.ok) {
                setMessages((prev) => [...prev, { id: `gd-${Date.now()}`, role: "system", text: `✓ Goal DONE and VERIFIED — ${v.ranCommands.join(" && ")} passed (${completed} cycle${completed === 1 ? "" : "s"}).` }]);
                break;
              }
              verifyFails += 1;
              if (verifyFails > MAX_VERIFY_FAILS || (!uncapped && completed >= max)) {
                setMessages((prev) => [...prev, { id: `gd-${Date.now()}`, role: "warning", text:
                  `${ICON.goal} Model reported DONE, but \`${v.failedCommand}\` kept failing after ${verifyFails} fix attempt${verifyFails === 1 ? "" : "s"} — stopping for you to review. Last error:\n${(v.output || "").slice(-600)}` }]);
                break;
              }
              setMessages((prev) => [...prev, { id: `gd-${Date.now()}`, role: "system", text: `✗ Not done — \`${v.failedCommand}\` failed. Sending it back to fix (attempt ${verifyFails}/${MAX_VERIFY_FAILS}).` }]);
              pendingFailure = { failedCommand: v.failedCommand ?? verifyPlan.commands.join(" && "), output: v.output };
              continue;
            }

            // Not done → real progress check (did the cycle USE a tool?) + cap.
            if (res.toolCalls === 0) noProgress += 1; else noProgress = 0;
            if (noProgress >= MAX_NO_PROGRESS) {
              setMessages((prev) => [...prev, { id: `gd-${Date.now()}`, role: "warning", text:
                `${ICON.goal} Stopped: ${noProgress} cycles with no tool action — the model is describing steps, not doing them. Refine the goal, or try a stronger model.` }]);
              break;
            }
            if (!uncapped && completed >= max) {
              setMessages((prev) => [...prev, { id: `gd-${Date.now()}`, role: "system", text:
                `${ICON.goal} Reached the ${max}-cycle cap without a verified DONE. Run /goal "${objective}" to keep going.` }]);
              break;
            }
            // else → next cycle
          }
        } finally {
          goalActiveRef.current = false; setGoalActive(false);
        }
        break;
      }
      case "/expand": {
        // The transcript shows only an 8-line preview of a tool result; reveal the
        // FULL output (terminals can't click "+N more lines"). Read from the SESSION
        // LOG, not the live model context — auto-compaction/trimming evicts tool
        // output from context, so the old context-based lookup would say "nothing to
        // expand" right when the preview still dangles "(/expand to view)".
        const outs = toolOutputs(readSession(sessionRef.current));
        if (!outs.length) { setErrorLine("Nothing to expand — no tool output recorded in this session yet."); break; }
        const n = Math.max(1, parseInt(arg.trim() || "1", 10) || 1);
        const target = outs[outs.length - n];
        if (target === undefined) { setErrorLine(`Only ${outs.length} tool result(s) recorded — /expand 1..${outs.length}.`); break; }
        const full = target;
        const allLines = full.split("\n");
        const CAP = 800;
        const shown = allLines.length > CAP
          ? allLines.slice(0, CAP).join("\n") + `\n… (+${allLines.length - CAP} more lines — full output is in the session log: /log)`
          : full;
        setMessages((prev) => [...prev, { id: `exp-${Date.now()}`, role: "system", text: `Full output of tool result #${n} (${allLines.length} lines):\n${shown}` }]);
        break;
      }
      case "/recover": {
        // Restore an earlier version of a file after a destructive edit. Sources:
        // the shadow backups taken before each mutation, plus the session log
        // (every FileWrite's bytes + every complete FileRead). Always writes to
        // <file>.recovered — never touches the working file — so it's safe to run.
        const parts = arg.trim().split(/\s+/).filter(Boolean);
        const rel = parts[0];
        if (!rel) {
          setErrorLine("Usage: /recover <file> [n] — restores a file's saved version to <file>.recovered (non-destructive). n picks an older version from the list.");
          break;
        }
        const pick = parts[1] ? Math.max(1, parseInt(parts[1], 10) || 1) : 1;
        const abs = pathIsAbsolute(rel) ? rel : pathResolve(process.cwd(), rel);
        const snaps = collectSnapshots(process.cwd(), abs);
        if (!snaps.length) {
          setErrorLine(`No saved versions of ${rel} found in this project's backups or session log.`);
          break;
        }
        const chosen = snaps[pick - 1];
        if (!chosen) {
          setErrorLine(`Only ${snaps.length} version(s) available — /recover ${rel} 1..${snaps.length}.`);
          break;
        }
        const listing = snaps
          .map((s, i) => `  [${i + 1}] ${s.ts.replace("T", " ").replace(/\..*$/, "")}  ${s.lines} lines, ${s.bytes} bytes  (${s.source}${s.sessionId ? ` · ${s.sessionId}` : ""})`)
          .join("\n");
        const cur = currentFileInfo(abs);
        let dest: string;
        try {
          dest = writeRecovered(abs, chosen.content);
        } catch (err) {
          setErrorLine(`Could not write recovery file: ${(err as Error).message}`);
          break;
        }
        setMessages((prev) => [...prev, { id: `rec-${Date.now()}`, role: "system", text:
          `Recovered ${rel} → ${dest} (non-destructive — your working file is untouched).\n` +
          `Restored version [${pick}]: ${chosen.lines} lines, ${chosen.bytes} bytes (${chosen.source}${chosen.sessionId ? ` · session ${chosen.sessionId}` : ""}).\n` +
          (cur ? `Current on-disk file: ${cur.lines} lines, ${cur.bytes} bytes.\n` : "No current file on disk.\n") +
          `\nAll saved versions (newest first):\n${listing}\n\n` +
          `Diff it against your working copy before replacing; pick another with /recover ${rel} <n>.` }]);
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
            hooks: config.hooks, contextWindow: windowFor(model),
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
            hooks: config.hooks, contextWindow: windowFor(model),
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
        const KNOWN = ["anthropic", "openai", "gemini", "github-models", "openrouter", "bedrock", "vertex", "ollama", "lmstudio", "llama-server", "nim", "deepseek", "mock"];
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
          writeLastSession({ provider: newCfg.provider, model: newCfg.model, baseUrl: newCfg.baseUrl }, undefined, process.cwd());
          setCtxFill(trackerRef.current.contextFill());
          const local = ["ollama", "lmstudio", "llama-server", "mock"].includes(newCfg.provider);
          const text = !newCfg.apiKey && !local
            ? `Switched to ${arg} (model ${newCfg.model}) — but no API key found. Add one with:  freecode auth add ${arg}`
            : `Switched to ${arg} — pick a model:`;
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text }]);
          // Auto-open the model picker for the NEW provider (build it from newCfg
          // — the live `provider` instance is still the old one this render).
          await openModelPicker(buildProvider(newCfg), newCfg.model);
        } else {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Provider: ${config.provider}\nModel: ${model}\nEndpoint: ${defaultEndpoint(config.provider, config.baseUrl)}\nKey: ${config.apiKey ? "set" : "none"}\n\nSwitch with /provider <name> (${KNOWN.join(", ")}).` }]);
        }
        break;
      }
      case "/scan": {
        if (busy) { setErrorLine("Finish or interrupt the current turn before scanning."); break; }
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `${ICON.search} Scanning for Ollama + llama-server — localhost + online Tailscale peers + the LAN /24…` }]);
        setBusy(true);
        try {
          const servers = await discoverServers();
          if (!servers.length) {
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "No model servers found. A remote Ollama must bind 0.0.0.0:11434; a llama-server must be on :8080 (localhost also scans :8888; set FREECODE_LLAMA_PORTS=port,port for others), fronted by `tailscale serve` on 443, and reachable. Or point at it directly: --base-url http://host:PORT/v1." }]);
            break;
          }
          const kind = arg === "ollama" || arg === "llama-server" ? arg : undefined;
          const filtered = kind ? servers.filter((s) => s.kind === kind) : servers;
          if (!filtered.length) {
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `No ${kind} servers found (${servers.length} server(s) of other kinds were).` }]);
            break;
          }
          // Hand the results to an interactive picker: pick a server, then its
          // model, and switch the live session to it — no hand-typed endpoint.
          setScanPicker({ stage: "server", servers: filtered, idx: 0 });
        } catch (err) {
          setErrorLine(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setBusy(false);
        }
        break;
      }
      case "/advisor": // alias — same feature
      case "/consult": {
        if (busy) { setErrorLine("Finish or interrupt the current turn before consulting a supervisor."); break; }
        // Always open the provider picker (model picker opens on selection). The
        // task is optional: empty → the supervisor does a general review of the
        // work so far. You can also pass it inline: /consult <task>.
        setConsultPicker({ stage: "provider", task: arg.trim(), items: [...CONSULT_PROVIDERS], idx: 0 });
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
        const [sub, ...mrest] = arg.split(/\s+/);
        const subArg = mrest.join(" ");
        if (sub === "add") {
          const parsed = parseMcpAdd(subArg);
          if ("error" in parsed) { setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: parsed.error }]); break; }
          try {
            addMcpServer(parsed.name, parsed.server); // persist to settings.json
          } catch (err) {
            setErrorLine(`Couldn't write settings: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
          const cmd = [parsed.server.command, ...(parsed.server.args ?? [])].join(" ");
          if (mcp) {
            // Hot-load: connect now and inject its tools into the live session —
            // no restart. (Usable on your next message.)
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Connecting MCP server "${parsed.name}" (${cmd})…` }]);
            const st = await mcp.startServer(parsed.name, parsed.server);
            setMcpTools([...mcp.tools]);
            setMcpStatusState([...mcp.status]);
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: st.ok
              ? `✓ "${parsed.name}" connected — ${st.toolCount} tool(s) available now (saved to ${SETTINGS_PATH}).`
              : `Saved "${parsed.name}" to ${SETTINGS_PATH}, but it failed to connect: ${st.error}` }]);
          } else {
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `✓ Added MCP server "${parsed.name}" (${cmd}) → ${SETTINGS_PATH}\nRestart freecode to load it.` }]);
          }
          break;
        }
        if (sub === "remove" || sub === "rm") {
          const name = subArg.trim();
          if (!name) { setErrorLine("Usage: /mcp remove <name>"); break; }
          const removedCfg = removeMcpServer(name);
          let unloaded = false;
          if (mcp) { unloaded = await mcp.stopServer(name); setMcpTools([...mcp.tools]); setMcpStatusState([...mcp.status]); }
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: (removedCfg || unloaded)
            ? `✓ Removed MCP server "${name}"${unloaded ? " and unloaded it from this session" : ""}.`
            : `No MCP server named "${name}" in ${SETTINGS_PATH}.` }]);
          break;
        }
        // No subcommand: show LIVE status (this session) + CONFIGURED servers +
        // how to add one without hand-editing files.
        const live = (mcpStatusState ?? []).map((s) => s.ok ? `  ● ${s.name} — ${s.toolCount} tool(s)` : `  ✗ ${s.name} — ${s.error ?? "failed"}`);
        const configured = Object.entries(listConfiguredMcp());
        const cfgLines = configured.map(([n, c]) => `  · ${n}: ${[c.command, ...(c.args ?? [])].join(" ")}${c.disabled ? "  (disabled)" : ""}`);
        const usage = [
          "Add one (connects immediately, no restart, no JSON editing):",
          "  /mcp add <name> [ENV=value ...] <command> [args...]",
          "  e.g. /mcp add github npx -y @modelcontextprotocol/server-github",
          "  /mcp remove <name>",
          `Saved to: ${SETTINGS_PATH}${existsSync(SETTINGS_PATH) ? "" : " (will be created)"}`,
        ].join("\n");
        const body = [
          live.length ? `Connected this session:\n${live.join("\n")}` : "No MCP servers connected.",
          configured.length ? `Configured:\n${cfgLines.join("\n")}` : "",
          usage,
        ].filter(Boolean).join("\n\n");
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: body }]);
        break;
      }
      case "/help": {
        const custom = [...customCommands.values()].map((c) => `${`/${c.name}`}${c.description ? ` — ${c.description}` : ""} (${c.source})`);
        const text = SLASH_COMMANDS.join("\n")
          + `\n\n!<command> — run a shell command yourself in ${bashShellName()} (output is shown and given to the model)`
          + (custom.length ? `\n\nCustom commands:\n${custom.join("\n")}` : "");
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
      case "/memory": {
        const store = memoryRef.current;
        if (!store || !store.enabled) {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Cross-session memory is off. Set memory.baseUrl in ~/.freecode/settings.json (or FREECODE_HONCHO_URL) to a Honcho instance to enable it." }]);
          break;
        }
        const sub = arg.trim().toLowerCase();
        if (sub === "refresh" || sub === "reload") {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "· Refreshing memory from Honcho…" }]);
          await store.flush();
          const block = await store.recall();
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: block ? `${ICON.memory} memory refreshed — ${block.length} chars recalled.` : `${ICON.memory} memory refreshed — nothing recalled yet.` }]);
          break;
        }
        const st = await store.status();
        const lines = [
          `provider     honcho`,
          `endpoint     ${st.baseUrl}  (${st.reachable ? "reachable ✓" : "UNREACHABLE ✗"})`,
          `workspace    ${st.workspace}`,
          `peer         ${st.peer}`,
          `recalled     ${st.representationChars} chars${st.cardLines ? ` (+${st.cardLines} card lines)` : ""}`,
          `pending      ${st.pending} turn(s) queued for ingest`,
        ];
        const preview = store.context();
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: lines.join("\n") + (sub === "show" && preview ? `\n\n${preview}` : preview ? `\n\n(use /memory show to print the recalled text)` : "") }]);
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
            writeConversationState(sessionRef.current, result.messages);
            const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`);
            const freed = Math.max(0, result.beforeTokens - result.afterTokens);
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Compacted ${result.removedCount} older messages into a summary. Context ~${fmt(result.beforeTokens)} → ~${fmt(result.afterTokens)} tokens (freed ~${fmt(freed)}); ${result.messages.length} messages kept.` }]);
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
        const bare = (name ?? "").replace(/^\//, "");
        const custom = customCommands.get(bare);
        if (custom) {
          void submit(expandCommand(custom.body, arg));
          break;
        }
        // Invoke a project skill by name: /<skill> [args]. The skill body is
        // GUIDANCE for the agent to follow, not your message — so we frame it as
        // such and submit with skipEcho (the command was already echoed above),
        // otherwise the agent reads the dumped body as a spec you pasted.
        const skill = getSkill(bare, process.cwd());
        if (skill) {
          const task = arg.trim();
          const expanded = expandCommand(skill.body, task);
          const framed = task
            ? `Apply the "${skill.name}" skill below to the task — follow its guidance, don't restate it.\n\nTASK: ${task}\n\n--- skill: ${skill.name} ---\n${expanded}`
            : `Adopt the "${skill.name}" skill below as your operating guidance for what I ask next. Acknowledge in one line that it's active, then wait for my request — do NOT restate the skill or ask for a spec yet.\n\n--- skill: ${skill.name} ---\n${expanded}`;
          void submit(framed, { skipEcho: true });
          break;
        }
        const suggestion = closest(name ?? "", slashNames, 3);
        setErrorLine(`Unknown command: ${name}${suggestion ? ` — did you mean ${suggestion}?` : ""}`);
      }
    }
  }

  useInput((input2, key) => {
    // Input diagnostics: FREECODE_PASTE_DEBUG=1 logs every keypress to
    // ~/.freecode/paste-debug.log — the exact chunk + key flags + the state the
    // history/menu decision reads — so paste AND history-scroll bugs are
    // inspectable instead of guessed. Off by default.
    if (process.env.FREECODE_PASTE_DEBUG) {
      try { appendFileSync(`${APP_DIR}/paste-debug.log`, JSON.stringify({ input: input2, len: input2.length, up: !!key.upArrow, down: !!key.downArrow, ret: !!key.return, esc: !!key.escape, histIdx: historyIdxRef.current, menu: menuMatches.length, picker: !!picker, modelPicker: !!modelPicker, pending: !!pending }) + "\n"); } catch { /* ignore */ }
    }
    if (key.ctrl && input2 === "c") {
      exitNow();
      return;
    }
    // While the resume picker is open, ↑/↓ choose, Enter resumes, Esc cancels.
    if (picker) {
      if (key.upArrow) { setPicker((p) => (p ? { ...p, idx: Math.max(0, p.idx - 1) } : p)); return; }
      if (key.downArrow) { setPicker((p) => (p ? { ...p, idx: Math.min(p.items.length - 1, p.idx + 1) } : p)); return; }
      if (key.return) { const sel = picker.items[picker.idx]; setPicker(null); if (sel) { doResume({ id: sel.id, cwd: sel.cwd, path: sel.path }); setupMemory(sel.id); } return; }
      if (key.escape) { setPicker(null); return; }
      return; // swallow everything else while picking
    }
    // While the model picker is open, ↑/↓ choose, Enter switches, Esc cancels.
    if (modelPicker) {
      const filtered = searchModels(modelPicker.all, modelPicker.query);
      if (key.upArrow) { setModelPicker((p) => (p ? { ...p, idx: Math.max(0, p.idx - 1) } : p)); return; }
      if (key.downArrow) { setModelPicker((p) => (p ? { ...p, idx: Math.min(filtered.length - 1, p.idx + 1) } : p)); return; }
      if (key.return) {
        const sel = filtered[Math.min(modelPicker.idx, filtered.length - 1)];
        setModelPicker(null);
        if (sel) {
          setModel(sel);
          trackerRef.current.setPricing(priceFor(sel, config.provider));
          trackerRef.current.setWindow(contextWindowFor(sel));
          setCtxFill(trackerRef.current.contextFill());
          writeLastSession({ provider: config.provider, model: sel, baseUrl: config.baseUrl }, undefined, process.cwd());
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Model switched to ${sel} (provider: ${config.provider}). Active from your next message.` }]);
        }
        return;
      }
      if (key.escape) { setModelPicker(null); return; }
      // Type to filter: backspace edits the query, printable chars extend it. Any
      // edit resets the cursor to the top of the new result set.
      if (key.backspace || key.delete || (input2 && /^[\x08\x7f]+$/.test(input2))) {
        setModelPicker((p) => (p ? { ...p, query: p.query.slice(0, -1), idx: 0 } : p));
        return;
      }
      if (input2 && !key.ctrl && !key.meta) {
        const clean = input2.replace(/[\x00-\x1f\x7f]/g, "");
        if (clean) setModelPicker((p) => (p ? { ...p, query: p.query + clean, idx: 0 } : p));
      }
      return; // swallow everything else while picking
    }
    // /consult picker — stage 1 chooses the supervisor provider, stage 2 its model.
    if (consultPicker) {
      const cp = consultPicker;
      if (cp.stage === "provider") {
        if (key.upArrow) { setConsultPicker({ ...cp, idx: Math.max(0, cp.idx - 1) }); return; }
        if (key.downArrow) { setConsultPicker({ ...cp, idx: Math.min(cp.items.length - 1, cp.idx + 1) }); return; }
        if (key.return) { const sel = cp.items[cp.idx]; setConsultPicker(null); if (sel) void consultPickProvider(sel, cp.task); return; }
        if (key.escape) { setConsultPicker(null); return; }
        return; // swallow everything else
      }
      // stage "model" — mirrors the model picker (↑/↓, Enter, Esc, type to filter).
      const filtered = searchModels(cp.all, cp.query);
      if (key.upArrow) { setConsultPicker({ ...cp, idx: Math.max(0, cp.idx - 1) }); return; }
      if (key.downArrow) { setConsultPicker({ ...cp, idx: Math.min(filtered.length - 1, cp.idx + 1) }); return; }
      if (key.return) {
        const sel = filtered[Math.min(cp.idx, filtered.length - 1)];
        setConsultPicker(null);
        if (sel) void startConsult(cp.cfg, sel, cp.task);
        return;
      }
      if (key.escape) { setConsultPicker(null); return; }
      if (key.backspace || key.delete || (input2 && /^[\x08\x7f]+$/.test(input2))) {
        setConsultPicker({ ...cp, query: cp.query.slice(0, -1), idx: 0 });
        return;
      }
      if (input2 && !key.ctrl && !key.meta) {
        const clean = input2.replace(/[\x00-\x1f\x7f]/g, "");
        if (clean) setConsultPicker({ ...cp, query: cp.query + clean, idx: 0 });
      }
      return; // swallow everything else while picking
    }
    // /scan picker — stage 1 picks a discovered server, stage 2 its model.
    if (scanPicker) {
      const sp = scanPicker;
      if (sp.stage === "server") {
        if (key.upArrow) { setScanPicker({ ...sp, idx: Math.max(0, sp.idx - 1) }); return; }
        if (key.downArrow) { setScanPicker({ ...sp, idx: Math.min(sp.servers.length - 1, sp.idx + 1) }); return; }
        if (key.return) {
          const server = sp.servers[sp.idx];
          if (!server) { setScanPicker(null); return; }
          if (server.models.length) setScanPicker({ stage: "model", servers: sp.servers, server, all: server.models, query: "", idx: 0 });
          else { setScanPicker(null); applyDiscoveredServer(server, ""); } // no model list → switch, /model later
          return;
        }
        if (key.escape) { setScanPicker(null); return; }
        return; // swallow everything else
      }
      // stage "model" — type to filter; Enter switches; Esc goes back to the list.
      const filtered = searchModels(sp.all, sp.query);
      if (key.upArrow) { setScanPicker({ ...sp, idx: Math.max(0, sp.idx - 1) }); return; }
      if (key.downArrow) { setScanPicker({ ...sp, idx: Math.min(filtered.length - 1, sp.idx + 1) }); return; }
      if (key.return) {
        const sel = filtered[Math.min(sp.idx, filtered.length - 1)];
        setScanPicker(null);
        if (sel) applyDiscoveredServer(sp.server, sel);
        return;
      }
      if (key.escape) { setScanPicker({ stage: "server", servers: sp.servers, idx: Math.max(0, sp.servers.indexOf(sp.server)) }); return; }
      if (key.backspace || key.delete || (input2 && /^[\x08\x7f]+$/.test(input2))) {
        setScanPicker({ ...sp, query: sp.query.slice(0, -1), idx: 0 });
        return;
      }
      if (input2 && !key.ctrl && !key.meta) {
        const clean = input2.replace(/[\x00-\x1f\x7f]/g, "");
        if (clean) setScanPicker({ ...sp, query: sp.query + clean, idx: 0 });
      }
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
    // esc interrupts a running turn — and a running /goal (even during its verify
    // window, when `busy` is briefly false), stopping the loop like `/goal stop`.
    if (key.escape && (busy || goalActiveRef.current)) {
      abortRef.current?.abort();
      if (goalActiveRef.current) { goalActiveRef.current = false; setGoalActive(false); }
      return;
    }
    // Bracketed paste, assembled across chunks. Ink strips the ESC and splits a
    // paste into one chunk per line (and may deliver inter-line newlines as
    // Enter), which leaked the "[200~"/"[201~" markers and joined lines. Collect
    // the line-pieces until the end marker, then collapse a multi-line paste to a
    // chip (single-line → inserted inline).
    if (hasPasteStart(input2) || pasteCollectRef.current) {
      if (hasPasteStart(input2)) pasteCollectRef.current = [];
      if (key.return) return; // swallow a mid-paste newline; the join restores it
      const s = input2.split(String.fromCharCode(27)).join("");
      const startAt = s.indexOf("[200~");
      let body = startAt >= 0 ? s.slice(startAt + 5) : s;
      const endAt = body.indexOf("[201~");
      if (endAt >= 0) body = body.slice(0, endAt);
      if (body) pasteCollectRef.current!.push(body);
      if (endAt >= 0) {
        // Canonicalise CRLF / lone-CR line endings to "\n" so multi-line detection,
        // the chip, the echo, and the submitted text all agree — a stray "\r" would
        // otherwise collapse the rendered message to just its last line.
        const content = normalizeNewlines(pasteCollectRef.current!.join("\n"));
        pasteCollectRef.current = null;
        if (shouldCollapse(content)) {
          const id = pasteRef.current.next++;
          pasteRef.current.map.set(id, content);
          const chip = pastePlaceholder(id, content);
          setEditor((e) => ({ text: e.text.slice(0, e.cursor) + chip + e.text.slice(e.cursor), cursor: e.cursor + chip.length }));
        } else if (content) {
          setEditor((e) => ({ text: e.text.slice(0, e.cursor) + content + e.text.slice(e.cursor), cursor: e.cursor + content.length }));
        }
      }
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
    // The slash menu owns up/down ONLY when NOT browsing history. Decide from the
    // REF (always current), so a held/fast arrow can't slip through on a stale
    // render and let the menu hijack scrolling at a recalled /command.
    const browsing = historyIdxRef.current !== null;
    if (!browsing && menuMatches.length > 0 && key.upArrow) { setMenuIdx((i) => Math.max(0, i - 1)); return; }
    if (!browsing && menuMatches.length > 0 && key.downArrow) { setMenuIdx((i) => Math.min(menuMatches.length - 1, i + 1)); return; }
    // Command history (up/down) — all reads/writes go through historyIdxRef so
    // navigation stays correct even under key auto-repeat.
    if (key.upArrow) {
      const h = historyRef.current;
      if (h.length === 0) return;
      const cur = historyIdxRef.current;
      const idx = cur === null ? h.length - 1 : Math.max(0, cur - 1);
      if (cur === null) draftRef.current = input;
      historyIdxRef.current = idx; setHistoryIdx(idx);
      setEditor({ text: h[idx]!, cursor: h[idx]!.length });
      return;
    }
    if (key.downArrow) {
      const cur = historyIdxRef.current;
      if (cur === null) return;
      const h = historyRef.current;
      if (cur >= h.length - 1) {
        historyIdxRef.current = null; setHistoryIdx(null);
        setEditor({ text: draftRef.current, cursor: draftRef.current.length });
      } else {
        const idx = cur + 1;
        historyIdxRef.current = idx; setHistoryIdx(idx);
        setEditor({ text: h[idx]!, cursor: h[idx]!.length });
      }
      return;
    }
    if (key.leftArrow) { setEditor((e) => ({ ...e, cursor: Math.max(0, e.cursor - 1) })); return; }
    if (key.rightArrow) { setEditor((e) => ({ ...e, cursor: Math.min(e.text.length, e.cursor + 1) })); return; }
    if (key.tab) {
      if (menuOpen) {
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
      // Substitute any paste chips ("[#N +L lines]") back to their full content.
      const value = expandPastes(resolveSubmit(input, menuOpen ? menuMatches.map((m) => m.name) : [], menuIdx), pasteRef.current.map);
      if (value.trim()) {
        const h = historyRef.current;
        if (h[h.length - 1] !== value) h.push(value);
      }
      setEditor({ text: "", cursor: 0 });
      historyIdxRef.current = null; setHistoryIdx(null);
      pasteRef.current = { next: 1, map: new Map() }; // chips consumed; reset for the next line
      if (!value.trim()) return;
      // Mid-turn input is queued, not run concurrently (submit/runSlash can't
      // overlap a live turn) — so the user's steering isn't silently dropped.
      // Show it in the history right away (as the user's own message, persisted),
      // so what you typed is visible in order; it's sent when the turn finishes.
      if (busy || pending || goalActiveRef.current) {
        queuedInputRef.current.push(value);
        setQueuedCount(queuedInputRef.current.length);
        if (!value.startsWith("/")) {
          setMessages((prev) => [...prev, { id: `q-${Date.now()}`, role: "user", text: `${value}  ⏳ queued` }]);
          appendEvent(sessionRef.current, { kind: "user", text: value, ts: new Date().toISOString() });
        } else {
          setMessages((prev) => [...prev, { id: `q-${Date.now()}`, role: "system", text: `⏳ ${value} queued (runs when the current turn finishes)` }]);
        }
        return;
      }
      if (value.startsWith("/")) {
        void runSlash(value);
      } else if (value.startsWith("!")) {
        void runBang(value);
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
      if (historyIdxRef.current !== null) { historyIdxRef.current = null; setHistoryIdx(null); } // editing a recalled line = leave browse mode
      setEditor((e) => {
        const c = Math.max(0, e.cursor - bs);
        return { text: e.text.slice(0, c) + e.text.slice(e.cursor), cursor: c };
      });
      return;
    }
    // Insert printable input. Strip control characters so stray DEL/BS bytes
    // from key bursts are never inserted (which previously pushed the caret), and
    // strip any leaked bracketed-paste markers as a backstop.
    if (input2 && !key.ctrl && !key.meta) {
      const clean = input2.replace(/[\x00-\x1F\x7F]/g, "").split("[200~").join("").split("[201~").join("");
      if (clean) {
        if (historyIdxRef.current !== null) { historyIdxRef.current = null; setHistoryIdx(null); } // typing = leave history-browse so the menu works again
        setEditor((e) => ({ text: e.text.slice(0, e.cursor) + clean + e.text.slice(e.cursor), cursor: e.cursor + clean.length }));
      }
    }
  });

  const endpoint = defaultEndpoint(config.provider, config.baseUrl);
  const isLocal = config.provider === "ollama" || config.provider === "lmstudio";
  // Live speedometer (recomputed each render; the spinner tick drives re-render).
  const speedText = busy && burstStartRef.current
    ? formatSpeed(tokensPerSecond(estTokens(burstCharsRef.current), Date.now() - burstStartRef.current))
    : "";

  // Memoize the <Static> scrollback items. The ~90ms spinner tick (and every other
  // state change) re-renders this component; without memoization each re-render
  // rebuilt the whole items array and made Ink re-commit EVERY settled message.
  // Over a long autonomous turn that re-processes the entire growing transcript
  // ~10×/message — the dominant driver of the heap climbing into the GBs and
  // OOMing (measured: with a fixed 300-message transcript, pure re-renders leaked
  // ~2KB each and cost ~26ms each; memoizing drops both by ~7×). Recomputes only
  // when the transcript actually changes.
  const staticItems = useMemo(() => buildStaticItems(introReady, messages, settled, staticBase), [introReady, messages, settled, staticBase]);

  return (
    <Box flexDirection="column">
      {/* Settled history lives in Static: the intro banner first, then every
          message from finished turns. Static writes each item to scrollback
          exactly once, so this whole region never re-renders. */}
      <Static
        // Append-only within a mount (see buildStaticItems); `key` remounts it to
        // free scrolled-off render trees on a marathon session. Gated on introReady
        // so a startup message can't land before the intro and duplicate on prepend.
        key={staticEpoch}
        items={staticItems}
      >
        {(item) =>
          item.kind === "intro" ? (
            <Box key={item.key} paddingX={1}>
              <Intro provider={config.provider} model={model} endpoint={endpoint} isLocal={isLocal} providerNote={providerReason(config.provider, config.source.provider)} hasKey={!!config.apiKey} theme={theme} />
            </Box>
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
          <Intro provider={config.provider} model={model} endpoint={endpoint} isLocal={isLocal} providerNote={providerReason(config.provider, config.source.provider)} hasKey={!!config.apiKey} theme={theme} eyeOffset={introEye} />
        </Box>
      )}

      {/* The in-flight turn (and transient status) — the only part that reflows.
          Bounded to the viewport while streaming so a reply taller than the screen
          can't overflow Ink's repaint and vanish; the full text lands in <Static>
          the moment it settles (see clampToViewport). */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {(() => {
            const live = messages.slice(settled).filter((m) => m.id);
            if (!busy) return live.map((m, i) => <MessageLine key={`${m.id}:${settled + i}`} m={m} theme={theme} />);
            // Fill a viewport-sized row budget from the BOTTOM (newest content),
            // clamping/dropping older live messages first. Reserve rows for the
            // spinner, owl, any approval box, and the input frame below.
            const budget = Math.max(6, (process.stdout.rows ?? 24) - 12);
            const width = process.stdout.columns ?? 80;
            let remaining = budget;
            let clippedAny = false;
            const out: JSX.Element[] = [];
            for (let i = live.length - 1; i >= 0; i--) {
              const m = live[i]!;
              if (remaining <= 0) { clippedAny = true; break; }
              const c = clampToViewport(m.text ?? "", remaining, width);
              if (c.clipped) clippedAny = true;
              remaining -= c.rows;
              out.unshift(<MessageLine key={`${m.id}:${settled + i}`} m={c.clipped ? { ...m, text: c.text } : m} theme={theme} />);
            }
            if (clippedAny) out.unshift(<Text key="live-clip" color={theme.dim}>⋯ streaming — the full reply lands in the transcript when it finishes</Text>);
            return out;
          })()}
          {busy && (
            <Text color={workingHealthColor()}>
              {reducedMotion ? ICON.bullet : SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} Working… <Text dimColor>({Math.max(0, Math.floor((Date.now() - busyStartRef.current) / 1000))}s · esc to interrupt{queuedCount > 0 ? ` · ${queuedCount} queued` : ""}{speedText ? ` · ${ICON.bolt} ${speedText}` : ""})</Text>
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
      ) : consultPicker && consultPicker.stage === "provider" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.user} paddingX={1} marginTop={1}>
          <Text bold color={theme.user}>{ICON.eye} Consult a supervisor — pick a provider</Text>
          {consultPicker.items.map((p, i) => {
            const sel = i === consultPicker.idx;
            return (
              <Text key={p} color={sel ? theme.user : undefined} dimColor={!sel}>
                {sel ? `${ICON.prompt} ` : "  "}{p}{p === config.provider ? "  (current)" : ""}
              </Text>
            );
          })}
          <Text dimColor>  ↑/↓ select · Enter choose · Esc cancel</Text>
        </Box>
      ) : consultPicker && consultPicker.stage === "model" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.user} paddingX={1} marginTop={1}>
          <Text bold color={theme.user}>{ICON.eye} Supervisor model — {consultPicker.providerId}</Text>
          <Text>
            <Text dimColor>search </Text>
            <Text color={theme.user}>{consultPicker.query}</Text>
            <Text inverse> </Text>
          </Text>
          {(() => {
            const cp = consultPicker;
            const filtered = searchModels(cp.all, cp.query);
            if (!filtered.length) return <Text color={theme.hex.warning}>  no models match “{cp.query}”</Text>;
            const idx = Math.min(cp.idx, filtered.length - 1);
            const { slice, offset } = pickerWindow(filtered, idx, 12);
            const tail = filtered.length - offset - slice.length;
            return (
              <>
                {offset > 0 && <Text dimColor>{`  ↑ ${offset} more`}</Text>}
                {slice.map((m, i) => {
                  const sel = offset + i === idx;
                  return <Text key={m} color={sel ? theme.user : undefined} dimColor={!sel}>{sel ? `${ICON.prompt} ` : "  "}{m}</Text>;
                })}
                {tail > 0 && <Text dimColor>{`  ↓ ${tail} more`}</Text>}
              </>
            );
          })()}
          <Text dimColor>  type to filter · ↑/↓ select · Enter consult · Esc cancel</Text>
        </Box>
      ) : scanPicker && scanPicker.stage === "server" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.user} paddingX={1} marginTop={1}>
          <Text bold color={theme.user}>{ICON.search} Discovered servers — pick one</Text>
          {scanPicker.servers.map((s, i) => {
            const sel = i === scanPicker.idx;
            const models = s.models.slice(0, 4).join(", ") + (s.models.length > 4 ? `, +${s.models.length - 4}` : "");
            const ctx = s.contextLength ? ` · ${s.contextLength.toLocaleString()} ctx` : "";
            const current = s.baseUrl === config.baseUrl;
            return (
              <Text key={s.endpoint} color={sel ? theme.user : undefined} dimColor={!sel}>
                {sel ? `${ICON.prompt} ` : "  "}{s.kind} · {s.endpoint}{ctx}{current ? " (current)" : ""}  <Text dimColor>({s.models.length}: {models || "n/a"})</Text>
              </Text>
            );
          })}
          <Text dimColor>  ↑/↓ select · Enter choose · Esc cancel</Text>
        </Box>
      ) : scanPicker && scanPicker.stage === "model" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.user} paddingX={1} marginTop={1}>
          <Text bold color={theme.user}>{ICON.search} Model on {scanPicker.server.endpoint}</Text>
          <Text>
            <Text dimColor>search </Text>
            <Text color={theme.user}>{scanPicker.query}</Text>
            <Text inverse> </Text>
          </Text>
          {(() => {
            const sp = scanPicker;
            const filtered = searchModels(sp.all, sp.query);
            if (!filtered.length) return <Text color={theme.hex.warning}>  no models match “{sp.query}”</Text>;
            const idx = Math.min(sp.idx, filtered.length - 1);
            const { slice, offset } = pickerWindow(filtered, idx, 12);
            const tail = filtered.length - offset - slice.length;
            return (
              <>
                {offset > 0 && <Text dimColor>{`  ↑ ${offset} more`}</Text>}
                {slice.map((m, i) => {
                  const sel = offset + i === idx;
                  return <Text key={m} color={sel ? theme.user : undefined} dimColor={!sel}>{sel ? `${ICON.prompt} ` : "  "}{m}</Text>;
                })}
                {tail > 0 && <Text dimColor>{`  ↓ ${tail} more`}</Text>}
              </>
            );
          })()}
          <Text dimColor>  type to filter · ↑/↓ select · Enter switch · Esc back</Text>
        </Box>
      ) : modelPicker ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.user} paddingX={1} marginTop={1}>
          <Text bold color={theme.user}>Select a model — {config.provider}</Text>
          <Text>
            <Text dimColor>search </Text>
            <Text color={theme.user}>{modelPicker.query}</Text>
            <Text inverse> </Text>
          </Text>
          {(() => {
            const filtered = searchModels(modelPicker.all, modelPicker.query);
            if (!filtered.length) return <Text color={theme.hex.warning}>  no models match “{modelPicker.query}”</Text>;
            const height = 12;
            const idx = Math.min(modelPicker.idx, filtered.length - 1);
            const { slice, offset } = pickerWindow(filtered, idx, height);
            const tail = filtered.length - offset - slice.length;
            return (
              <>
                {offset > 0 && <Text dimColor>{`  ↑ ${offset} more`}</Text>}
                {slice.map((m, i) => {
                  const sel = offset + i === idx;
                  const isCurrent = m === model;
                  return (
                    <Text key={m} color={sel ? theme.user : undefined} dimColor={!sel}>
                      {sel ? `${ICON.prompt} ` : "  "}{isCurrent ? "→ " : "  "}
                      {/* highlight "free" in hot pink; other parts inherit the line style */}
                      {m.split(/(free)/i).map((part, j) =>
                        /^free$/i.test(part)
                          ? <Text key={j} color="#ff69b4" bold>{part}</Text>
                          : part,
                      )}
                    </Text>
                  );
                })}
                {tail > 0 && <Text dimColor>{`  ↓ ${tail} more`}</Text>}
              </>
            );
          })()}
          <Text dimColor>  type to filter · ↑/↓ select · Enter switch · Esc cancel</Text>
        </Box>
      ) : picker ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.user} paddingX={1} marginTop={1}>
          <Text bold color={theme.user}>Resume a session</Text>
          {picker.items.map((s, i) => {
            const sel = i === picker.idx;
            const label = s.title || s.preview || "(empty session)";
            return (
              <Text key={s.id} color={sel ? theme.user : undefined} dimColor={!sel}>
                {sel ? `${ICON.prompt} ` : "  "}{label.padEnd(42).slice(0, 42)}  <Text dimColor>{`${s.count} msg · ${relTime(s.mtime)}`}</Text>
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

      {/* Slash-command suggestions render BELOW the input so typing a command
          never shoves the input box up/down — the input stays put. */}
      {!pending && !modelPicker && !picker && !consultPicker && menuOpen && (
        <Box flexDirection="column" paddingX={1}>
          {menuMatches.map((m, i) => {
            const sel = i === Math.min(menuIdx, menuMatches.length - 1);
            return (
              <Text key={m.name} color={sel ? theme.user : undefined} dimColor={!sel}>
                {sel ? `${ICON.prompt} ` : "  "}{m.name}{m.desc ? `  —  ${m.desc}` : ""}
              </Text>
            );
          })}
          <Text dimColor>  ↑/↓ select · Enter run · Tab fill (for args)</Text>
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
          <Text color={theme.dim}>{cwdBase}  </Text>
          <ConfidenceBadge state={confidence} theme={theme} />
          <Text dimColor>  · ctx </Text>
          <Text color={{ ok: theme.hex.success, warn: theme.hex.warning, crit: theme.hex.error }[contextTone(ctxFill)]}>{contextBar(ctxFill)}</Text>
          <Text dimColor> {Math.round(ctxFill * 100)}%{ctxTokens > 0 ? ` (${formatTokens(ctxTokens)}/${formatTokens(trackerRef.current.window())})` : ""} · </Text>
          <Text color={theme.dim}>{isLanModelEndpoint(config.provider, config.baseUrl) ? `${ICON.globe} ${endpointHostLabel(config.baseUrl, config.provider)} · ` : ""}{serverLabel ?? config.provider}:</Text>
          <Text color={theme.hex.assistant}>{model}</Text>
          <Text dimColor>  cost </Text>
          <Text color={theme.hex.success}>${costUsd.toFixed(4)}</Text>
        </Text>
      </Box>
    </Box>
  );
}
