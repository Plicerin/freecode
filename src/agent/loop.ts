import type { Provider, ChatRequest, ChatMessage, ToolCall, TokenUsage, ImagePart } from "../providers/types";
import type { Tool } from "../tools/types";
import type { PermissionEngine, ApprovalCallback } from "../permissions/modes";
import { withRetry, isRateLimitError } from "../utils/retry";
import { isRetryable } from "../providers/friendly-errors";
import { debug } from "../utils/debug";
import { toolListToSystemPrompt } from "../tools/registry";
import { ContextTracker } from "./context";
import { estimateMessagesTokens, trimToFit } from "./token-estimate";
import { overclaimWarning } from "./overclaim";
import { looksLikeTextToolCall } from "./text-tool-call";
import { getEnv } from "../utils/env";
import { summarizeConversation } from "./summarize";
import { runHooks } from "./hooks";
import { runVerify, type VerifyPlan } from "./verify";
import { sanitizeToolPairing } from "./sanitize";
import { redactSecrets } from "../utils/redact";
import { logActivity } from "../utils/activity";
import type { HooksConfig } from "../config/schema";

export interface TurnLedger {
  verified: string[];
  observed: string[];
  believed: string[];
  /** A loud caution when the reply's success claim isn't backed by evidence. */
  warning?: string;
}

export interface AgentEvent {
  type: "text_delta" | "tool_call" | "tool_result" | "thinking_delta" | "usage" | "done" | "error" | "approval_needed" | "compacted" | "verify" | "ledger";
  text?: string;
  call?: ToolCall;
  result?: { id: string; output: string; ok: boolean; durationMs: number };
  usage?: TokenUsage;
  error?: string;
  reason?: string;
  tool?: string;
  argsSummary?: string;
  ledger?: TurnLedger;
}

export interface AgentLoopOptions {
  provider: Provider;
  tools: Tool[];
  model: string;
  maxTurns: number;
  systemPrompt?: string;
  prompt: string;
  /** Images to attach to the initial user message (multimodal input). */
  images?: ImagePart[];
  /** Prior conversation (provider-format) to continue, enabling multi-turn memory. */
  history?: ChatMessage[];
  permission: PermissionEngine;
  promptUser: ApprovalCallback;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  contextWindow?: number;
  contextThreshold?: number;
  enablePromptCache?: boolean;
  enableExtendedThinking?: boolean;
  hooks?: HooksConfig;
  /** Tools that EXIST but are filtered out right now (e.g. write/exec tools in
   *  plan mode) — so a call to one gets a clear "restricted" message, not the
   *  misleading "tool not found". */
  restrictedToolNames?: string[];
  /** Auto-verify gate: run these checks after a file-changing turn. */
  verifyPlan?: VerifyPlan;
  verifyMode?: "off" | "on" | "strict";
}

/** Per-turn output-token cap. 8192 truncates a large FileWrite (a whole game.js,
 *  a full index.html) mid-write — the turn then ends and the user has to say
 *  "continue". 16k fits most modern models; FREECODE_MAX_OUTPUT_TOKENS overrides. */
function maxOutputTokens(): number {
  const n = Number(getEnv("FREECODE_MAX_OUTPUT_TOKENS"));
  return Number.isFinite(n) && n > 0 ? n : 16384;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<{ turns: number; usage: TokenUsage; aborted: boolean; messages: ChatMessage[] }> {
  const tools = opts.tools;
  const maxOut = maxOutputTokens();
  const messages: ChatMessage[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.prompt, ...(opts.images?.length ? { images: opts.images } : {}) },
  ];
  const sys = opts.systemPrompt ?? toolListToSystemPrompt(tools);

  const tracker = new ContextTracker({
    windowSize: opts.contextWindow,
    threshold: opts.contextThreshold,
  });

  // Summarize older messages by asking the provider for a concise recap.
  const summarize = (msgs: ChatMessage[]): Promise<string> =>
    summarizeConversation(opts.provider, opts.model, msgs, opts.signal);

  const windowSize = opts.contextWindow ?? 200_000;
  const threshold = opts.contextThreshold ?? 0.8;
  // Approximate live context size = tokens sent+produced on the most recent
  // turn (the whole history is re-sent each turn, so this tracks the window).
  let contextTokens = 0;

  let total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  let turns = 0;
  let aborted = false;
  let lastTurnToolCalls = 0; // tool-call count of the most recent turn (outer scope)
  let producedText = false; // did the model say anything useful at all this run?

  // Auto-continue: when a reply is cut off at the output cap mid-thought (no tool
  // call), resume it automatically instead of dead-ending and making the user
  // type "continue". Bounded so a model that just reasons in circles can't loop
  // forever; the counter resets whenever the model actually acts (calls a tool).
  const rawAutoContinue = Number.parseInt(process.env.FREECODE_MAX_AUTO_CONTINUE ?? "3", 10);
  const MAX_AUTO_CONTINUE = Number.isFinite(rawAutoContinue) && rawAutoContinue >= 0 ? rawAutoContinue : 3;
  let autoContinues = 0;

  // Auto-verify gate state.
  const verifyMode = opts.verifyMode ?? "off";
  const verifyEnabled = verifyMode !== "off" && (opts.verifyPlan?.commands.length ?? 0) > 0;
  const MAX_VERIFY = 3;
  let changed = false; // a file-mutating tool succeeded this task
  let verifyAttempts = 0;
  let verifyFailed = false;
  let verifiedCommands: string[] = []; // checks that actually passed (auto-gate)
  // Checks the AGENT ran itself (build/test/typecheck/lint) that passed. These
  // are real verification too — not just freecode's auto-gate — so nested or
  // monorepo projects, whose checks live in a subdir the gate's cwd can't see,
  // still earn a verified badge. Cleared on every file change so a passing check
  // only credits the state that existed AFTER the last edit (no stale green).
  // A check's MOST RECENT outcome wins: passing adds it here and clears any prior
  // failure; failing removes it here and records the failure below. Without this,
  // an earlier `tests PASS` would mask a later `tests FAIL` and report a false
  // green — the one thing the confidence signal must never do.
  const agentChecks = new Set<string>();
  const agentCheckFailures = new Set<string>();
  // Circuit-breaker: stop flailing if tools keep failing with no progress.
  const MAX_TOOL_FAILURES = 8;
  let consecutiveFailures = 0;
  let lastFailureMsg = "";

  // Provenance ledger — machine-derived facts about what the agent really did.
  const led = { wrote: [] as string[], edited: [] as string[], read: 0, ran: [] as string[], searched: 0, viewed: 0, other: [] as string[] };

  while (turns < opts.maxTurns) {
    turns += 1;
    if (opts.signal?.aborted) { aborted = true; break; }

    // Auto-compact when the context window fills up (SPEC V14). The usage-based
    // gauge (contextTokens) lags by a turn, so estimate the outgoing prompt too —
    // a large input added THIS turn (a fetched page, big paste, verbose tool
    // result) would otherwise sail past the gauge into a doomed request.
    const estimated = estimateMessagesTokens(messages, sys);
    const fillBasis = Math.max(contextTokens, estimated);
    if (fillBasis >= windowSize * threshold && messages.length > 4) {
      try {
        const result = await tracker.compact(messages, summarize);
        if (result.removedCount > 0) {
          messages.splice(0, messages.length, ...result.messages);
          opts.onEvent({
            type: "compacted",
            text: `Context auto-compacted: summarized ${result.removedCount} older messages (~${result.summaryTokens} tokens).`,
          });
        }
      } catch (err) {
        debug.warn("compaction failed; continuing without it", { err: String(err) });
      }
    }
    // Hard guard: if the prompt STILL won't fit (compaction can't shrink a single
    // oversized message in the kept tail), stop with a clear error instead of
    // letting the provider reject it — e.g. NIM computes max_tokens = window −
    // prompt and 400s on the resulting negative value. Reserve room for a reply.
    const reserve = Math.min(8192, Math.max(512, Math.floor(windowSize * 0.05)));
    let finalEstimate = estimateMessagesTokens(messages, sys);
    // Compaction summarizes the middle but keeps the recent tail; if a big chunk
    // sits there it can stay over a small (local) window. Rather than dead-end,
    // drop the oldest messages to fit — keep the first (context) and the latest.
    if (finalEstimate + reserve > windowSize && messages.length > 2) {
      const { messages: trimmed, dropped } = trimToFit(messages, sys, Math.max(0, windowSize - reserve));
      if (dropped > 0) {
        const fixed = sanitizeToolPairing(trimmed);
        messages.splice(0, messages.length, ...fixed);
        opts.onEvent({ type: "compacted", text: `Trimmed ${dropped} old message(s) to fit ${opts.model}'s ${windowSize.toLocaleString()}-token window.` });
        finalEstimate = estimateMessagesTokens(messages, sys);
      }
    }
    if (finalEstimate + reserve > windowSize) {
      opts.onEvent({
        type: "error",
        error:
          `This turn (~${finalEstimate.toLocaleString()} tokens) is too large for ${opts.model}'s ` +
          `${windowSize.toLocaleString()}-token context window even after trimming — a single input is bigger than the window. ` +
          `Start fresh with /new, or remove the large input (a big pasted file, or a fetched page/binary).`,
      });
      break;
    }
    const req: ChatRequest = {
      model: opts.model,
      system: sys,
      // Guarantee tool_call/tool_result pairing before sending. Compaction (just
      // above) or a resumed-but-corrupted history can otherwise orphan a call and
      // make the provider reject every request.
      messages: sanitizeToolPairing(messages),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.schema as never,
        permission: t.permission,
        parameters: t.parameters,
      })),
      stream: true,
      maxTokens: maxOut,
      enablePromptCache: opts.enablePromptCache,
      enableExtendedThinking: opts.enableExtendedThinking,
      signal: opts.signal,
    };

    let turnText = "";
    let turnToolCalls: ToolCall[] = [];
    let sawError = false;
    let emitted = false;
    let endReason: string | undefined; // why the provider stopped this turn

    // Stream events live (dispatch as they arrive) so the UI can render tokens
    // incrementally. Retry only applies before the first event (e.g. a 429 at
    // connection time); once streaming has started we don't re-run.
    await withRetry(
      async () => {
        turnText = "";
        turnToolCalls = [];
        sawError = false;
        endReason = undefined;
        for await (const e of opts.provider.stream(req)) {
          emitted = true;
          switch (e.type) {
            case "text_delta":
              turnText += e.delta;
              opts.onEvent({ type: "text_delta", text: e.delta });
              break;
            case "thinking_delta":
              opts.onEvent({ type: "thinking_delta", text: e.delta });
              break;
            case "tool_call":
              turnToolCalls.push(e.call);
              opts.onEvent({ type: "tool_call", call: e.call });
              break;
            case "usage":
              if (e.usage) {
                total = sumUsage(total, e.usage);
                contextTokens = e.usage.input + e.usage.output;
                opts.onEvent({ type: "usage", usage: e.usage });
              }
              break;
            case "end":
              endReason = e.reason;
              if (e.reason === "error") aborted = true;
              break;
            case "error":
              sawError = true;
              aborted = true;
              opts.onEvent({ type: "error", error: String((e.error as Error)?.message ?? e.error) });
              break;
          }
        }
      },
      // Retry only BEFORE the first event (a 429 or a connect/stall timeout at
      // connection time). Once tokens are flowing we don't re-run a partial stream.
      { shouldRetry: (err) => !emitted && (isRateLimitError(err) || isRetryable(err)) },
    );

    messages.push({ role: "assistant", content: turnText, toolCalls: turnToolCalls });
    lastTurnToolCalls = turnToolCalls.length;

    if (turnText.trim()) producedText = true;
    if (sawError) break;

    // A reply cut off at the output cap with NO tool call was truncated
    // mid-thought. Auto-continue so the turn finishes on its own; only warn once
    // we've exhausted the budget (the model isn't converging).
    if (endReason === "max_tokens" && turnToolCalls.length === 0 && !opts.signal?.aborted) {
      if (autoContinues < MAX_AUTO_CONTINUE) {
        autoContinues += 1;
        messages.push({ role: "user", content: "Your previous reply was cut off at the output token limit. Continue from exactly where you left off — do not repeat what you already wrote. If you were about to call a tool, call it now instead of explaining." });
        opts.onEvent({ type: "compacted", text: `Reply hit the output token limit — auto-continuing (${autoContinues}/${MAX_AUTO_CONTINUE})…` });
        continue;
      }
      opts.onEvent({ type: "error", error: `⚠ The model's reply keeps hitting the output token limit (finish_reason=length) even after ${MAX_AUTO_CONTINUE} auto-continues — it may be stuck reasoning without converging. Raise FREECODE_MAX_OUTPUT_TOKENS, simplify the step, or try a less verbose / larger model.` });
    }
    // Make a silent stop legible: an empty reply, or a tool call leaked as text.
    else if (turnToolCalls.length === 0 && looksLikeTextToolCall(turnText)) {
      opts.onEvent({ type: "error", error: "⚠ The model wrote a tool call as TEXT (e.g. <function_calls>) instead of calling the tool — the provider isn't parsing this model's tool-call format into a structured call, so freecode can't run it. Use a model with provider-supported tool calling, or check the model's tool template/settings (common with some local models in LM Studio/Ollama)." });
    } else if (turnToolCalls.length === 0 && !turnText.trim() && !sawError && !producedText) {
      // Only flag a TRULY empty run — not a benign empty turn after the model
      // already gave a real answer (which is just it having nothing more to add).
      opts.onEvent({ type: "error", error: "⚠ The model returned an empty response — the turn ended without text or a tool call. This is usually the model, not freecode." });
    }

    if (turnToolCalls.length === 0) {
      // The agent is done talking. Earn the "done": if it changed files, run
      // the verify gate; on failure, feed it back and let it self-correct.
      if (verifyEnabled && changed && verifyAttempts < MAX_VERIFY && !opts.signal?.aborted) {
        verifyAttempts += 1;
        const plan = opts.verifyPlan!;
        opts.onEvent({ type: "verify", text: `⏳ Verifying: ${plan.commands.join(" && ")}…` });
        const res = await runVerify(plan, process.cwd(), opts.signal);
        if (opts.signal?.aborted) { aborted = true; break; }
        if (res.ok) {
          logActivity(`VERIFY ${res.ranCommands.join(" && ")} → PASS`);
          opts.onEvent({ type: "verify", text: `✓ Verified — ${res.ranCommands.join(" && ")} passed.` });
          verifyFailed = false;
          verifiedCommands = res.ranCommands;
          break;
        }
        logActivity(`VERIFY ${plan.commands.join(" && ")} → FAIL @ ${res.failedCommand}`);
        opts.onEvent({ type: "verify", text: `✗ Verification failed (${res.failedCommand}) — fixing…` });
        verifyFailed = true;
        changed = false;
        messages.push({ role: "user", content: `Verification failed running \`${res.failedCommand}\`:\n\n${res.output.slice(-3000)}\n\nFix the underlying cause, then we'll re-check.` });
        continue;
      }
      break;
    }

    // The model acted (called tools) → it's making progress, so refresh the
    // auto-continue budget for any later truncation.
    autoContinues = 0;

    // Execute tools sequentially; could parallelize later
    const pendingImages: ImagePart[] = [];
    for (const call of turnToolCalls) {
      if (opts.signal?.aborted) { aborted = true; break; }
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        const restricted = opts.restrictedToolNames?.includes(call.name);
        const msg = restricted
          ? `${call.name} is unavailable in plan mode (read-only). Don't try to run commands or edit files — investigate with FileRead/Grep/Glob and PROPOSE a plan. The user runs /plan to exit plan mode and let you act.`
          : `Error: tool ${call.name} not found`;
        messages.push({ role: "tool", toolCallId: call.id, content: msg });
        opts.onEvent({ type: "tool_result", result: { id: call.id, output: msg, ok: false, durationMs: 0 } });
        continue;
      }
      const argsSummary = JSON.stringify(call.arguments).slice(0, 200);
      const approval = await opts.permission.decide(
        { tool: tool.name, argsSummary, reason: tool.permission },
        opts.promptUser,
      );
      if (approval === "deny") {
        opts.permission.rememberDenied({ tool: tool.name, argsSummary });
        const deniedMsg = "User denied this tool call.";
        messages.push({ role: "tool", toolCallId: call.id, content: deniedMsg });
        opts.onEvent({ type: "tool_result", result: { id: call.id, output: deniedMsg, ok: false, durationMs: 0 } });
        continue;
      }
      const parsed = tool.schema.safeParse(call.arguments);
      if (!parsed.success) {
        const errMsg = `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
        messages.push({ role: "tool", toolCallId: call.id, content: errMsg });
        opts.onEvent({ type: "tool_result", result: { id: call.id, output: errMsg, ok: false, durationMs: 0 } });
        debug.warn(`${tool.name} args rejected`, { err: errMsg, raw: call.arguments });
        continue;
      }
      // PreToolUse hook — can veto the call (non-zero exit blocks it).
      const pre = await runHooks("PreToolUse", opts.hooks, { event: "PreToolUse", tool: tool.name, arguments: parsed.data, cwd: process.cwd() }, tool.name, opts.signal);
      if (pre.blocked) {
        const msg = `Blocked by PreToolUse hook: ${pre.reason}`;
        messages.push({ role: "tool", toolCallId: call.id, content: msg });
        opts.onEvent({ type: "tool_result", result: { id: call.id, output: msg, ok: false, durationMs: 0 } });
        continue;
      }
      const t0 = Date.now();
      const result = await tool.run(parsed.data, { cwd: process.cwd(), signal: opts.signal });
      const durationMs = Date.now() - t0;
      // Scrub secrets from tool output BEFORE it touches the model, transcript,
      // or session log. A `Get-ChildItem Env:` or `cat .env` can spill live keys.
      const red = redactSecrets(result.output);
      result.output = red.text;
      if (result.error) result.error = redactSecrets(result.error).text;
      const payload = (result.ok ? result.output : `Error: ${result.error ?? "unknown"}\n${result.output}`) +
        (red.count > 0 ? `\n[freecode redacted ${red.count} secret(s) from this output]` : "");
      if (result.ok) consecutiveFailures = 0;
      else { consecutiveFailures += 1; lastFailureMsg = `${tool.name}: ${result.error ?? result.output.slice(0, 160)}`; }
      if (result.ok && (tool.name === "FileWrite" || tool.name === "FileEdit")) {
        changed = true;
        // A new edit invalidates any earlier check outcome — the state it
        // measured no longer exists, so don't carry stale green OR red forward.
        agentChecks.clear();
        agentCheckFailures.clear();
      }
      // Record the action for the provenance ledger (facts, not the model's prose).
      const a = parsed.data as { path?: string; command?: string };
      if (tool.name === "FileWrite" && result.ok) led.wrote.push(a.path ?? "?");
      else if (tool.name === "FileEdit" && result.ok) led.edited.push(a.path ?? "?");
      else if (tool.name === "FileRead") led.read += 1;
      else if (tool.name === "Bash") {
        const cmd = String(a.command ?? "");
        led.ran.push(cmd.slice(0, 40));
        // Credit a check the agent ran itself toward confidence — but only if it
        // actually passed (exit 0). A failing check is real signal the other way.
        const check = recognizeCheckCommand(cmd);
        if (check) {
          if (result.ok) { agentChecks.add(check); agentCheckFailures.delete(check); logActivity(`CHECK ${check} → PASS (agent-run)`); }
          else { agentChecks.delete(check); agentCheckFailures.add(check); logActivity(`CHECK ${check} → FAIL (agent-run)`); }
        }
      }
      else if (tool.name === "Glob" || tool.name === "Grep") led.searched += 1;
      else if (tool.name === "ViewImage") led.viewed += 1;
      else led.other.push(tool.name);
      logActivity(`TOOL ${tool.name} ${argsSummary.slice(0, 100)} → ${result.ok ? "ok" : "FAIL"} (${durationMs}ms)${result.ok && changed && (tool.name === "FileWrite" || tool.name === "FileEdit") ? " [CHANGED]" : ""}`);
      messages.push({ role: "tool", toolCallId: call.id, content: payload });
      opts.onEvent({ type: "tool_result", result: { id: call.id, output: payload, ok: result.ok, durationMs } });
      // PostToolUse hook — observe the result (side effects only; can't block).
      await runHooks("PostToolUse", opts.hooks, { event: "PostToolUse", tool: tool.name, arguments: parsed.data, result: { ok: result.ok, output: result.output.slice(0, 4000) }, cwd: process.cwd() }, tool.name, opts.signal);
      // Collect any images the tool returned (e.g. ViewImage); they're surfaced
      // AFTER all tool results so the tool-response block stays contiguous
      // (providers reject a user message interleaved between tool results).
      if (result.images && result.images.length > 0) pendingImages.push(...result.images);
    }

    // Circuit-breaker: if tools keep failing with no successful action in
    // between, stop rather than flailing (e.g. the same FileEdit failing 50×).
    // Earned confidence includes the honesty to say "I'm stuck" instead of
    // retrying the identical failing call forever.
    if (consecutiveFailures >= MAX_TOOL_FAILURES) {
      const note = `Stopped after ${consecutiveFailures} consecutive tool failures with no progress. Last error — ${lastFailureMsg}`;
      logActivity(`STOP ${note}`);
      opts.onEvent({ type: "error", error: note });
      aborted = true;
    }

    // If we broke out of the tool loop early (esc interrupt), some calls in this
    // turn's assistant message have no result. Backfill them in-place so the
    // history we return — and persist — stays valid for the next turn.
    if (turnToolCalls.length > 0) {
      const fixed = sanitizeToolPairing(messages);
      messages.splice(0, messages.length, ...fixed);
    }

    // Feed collected tool images back as a single user message so the model sees them.
    if (pendingImages.length > 0) {
      messages.push({ role: "user", content: `[${pendingImages.length} image(s) loaded and now visible]`, images: pendingImages });
    }

    if (aborted) break;
  }

  // Exhausted the turn budget (the loop didn't break early via a no-tool-calls
  // "done") — the task is likely unfinished. Surface it instead of ending quietly.
  if (!aborted && lastTurnToolCalls > 0 && turns >= opts.maxTurns) {
    opts.onEvent({ type: "error", error: `⚠ Stopped after ${turns} turns (the max-turns cap, ${opts.maxTurns}). The task may be unfinished — raise maxTurns (or --max-turns) or tell it to continue.` });
  }

  if (verifyFailed && !aborted) {
    opts.onEvent({ type: "verify", text: `⚠ Checks still failing after ${verifyAttempts} attempt(s) — left as-is for you to review.` });
  }

  // Provenance ledger: what was Verified (checks passed) / Observed (tools that
  // actually ran) / Believed (asserted but unchecked). Derived from real events.
  {
    const names = (arr: string[]): string => (arr.length <= 2 ? arr.join(", ") : `${arr.length} files`);
    const observed: string[] = [];
    if (led.wrote.length) observed.push(`wrote ${names(led.wrote)}`);
    if (led.edited.length) observed.push(`edited ${names(led.edited)}`);
    if (led.read) observed.push(`read ${led.read} file(s)`);
    if (led.ran.length) observed.push(`ran ${led.ran.length <= 2 ? led.ran.map((c) => `\`${c}\``).join(", ") : `${led.ran.length} commands`}`);
    if (led.searched) observed.push(`searched ${led.searched}×`);
    if (led.viewed) observed.push(`viewed ${led.viewed} image(s)`);
    if (led.other.length) observed.push(`used ${[...new Set(led.other)].join(", ")}`);

    // Verified = checks that actually passed, from EITHER freecode's auto-gate or
    // the agent's own run. Agent-run ones are labelled so provenance stays honest.
    const ownChecks = [...agentChecks].filter((c) => !verifiedCommands.includes(c));
    const verified = [
      ...verifiedCommands.map((c) => `${c} passed`),
      ...ownChecks.map((c) => `${c} passed (agent-run)`),
    ];
    const someCheckPassed = verifiedCommands.length > 0 || ownChecks.length > 0;
    // A failing check (gate OR agent-run) dominates: even if a sibling check
    // passed, the code is in a failing state, so the badge must read failing —
    // never green. nextConfidence treats a "failing" believed entry as decisive.
    const anyFailed = verifyFailed || agentCheckFailures.size > 0;
    const believed: string[] = [];
    const changedCount = led.wrote.length + led.edited.length;
    if (anyFailed) {
      believed.push("checks failing — changes unconfirmed");
    } else if (changedCount > 0 && !someCheckPassed) {
      believed.push(`changed ${changedCount} file(s) without running checks — unverified`);
    }

    // Overclaim guard: if the final reply asserts sweeping success but freecode
    // confirmed no passing check (or one failed), say so loudly — a false green
    // must not hide behind confident prose.
    const finalText = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
    const warning = overclaimWarning(finalText, { changedCount, verifiedCount: verified.length, anyFailed }) ?? undefined;

    if (observed.length || verified.length || believed.length || warning) {
      logActivity(`LEDGER verified=[${verified.join("; ")}] observed=[${observed.join("; ")}] believed=[${believed.join("; ")}]${warning ? ` warning=[${warning}]` : ""}`);
      opts.onEvent({ type: "ledger", ledger: { verified, observed, believed, warning } });
    }
  }

  await runHooks("Stop", opts.hooks, { event: "Stop", turns, aborted, cwd: process.cwd() }, undefined, opts.signal);
  opts.onEvent({ type: "done", reason: aborted ? "aborted" : turns >= opts.maxTurns ? "max_turns" : "end_turn" });
  return { turns, usage: total, aborted, messages };
}

// Recognize a command the agent ran itself that constitutes a real check — a
// build / test / typecheck / lint / static-analysis run. Returns a short label
// if it looks like one, else null. Deliberately conservative: it must clearly be
// a verification command (not `npm run dev`/`start`, not a one-off script) so a
// passing run can be honestly credited toward the confidence badge.
export function recognizeCheckCommand(raw: string): string | null {
  const cmd = raw.trim().toLowerCase();
  if (!cmd) return null;
  // Package-manager script runs: npm/pnpm/yarn/bun [run] <build|test|typecheck|lint|check|verify|tsc>
  const pm = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|typecheck|type-check|lint|check|verify|tsc)\b/.exec(cmd);
  if (pm) return pm[0];
  // Bare tools / runners.
  if (/(^|\s)tsc(\s|$)/.test(cmd)) return "tsc";
  if (/\b(vitest|jest|playwright|mocha|ava)\b/.test(cmd)) return "tests";
  if (/\bpytest\b/.test(cmd) || /\bpython\s+-m\s+pytest\b/.test(cmd)) return "pytest";
  if (/\b(mypy|ruff|flake8|pylint)\b/.test(cmd)) return "lint";
  if (/\beslint\b/.test(cmd)) return "eslint";
  const cargo = /\bcargo\s+(check|test|build|clippy)\b/.exec(cmd);
  if (cargo) return `cargo ${cargo[1]}`;
  const goc = /\bgo\s+(test|build|vet)\b/.exec(cmd);
  if (goc) return `go ${goc[1]}`;
  const make = /\bmake\s+(test|check|lint|build|ci)\b/.exec(cmd);
  if (make) return `make ${make[1]}`;
  return null;
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    thinking: a.thinking + b.thinking,
  };
}
