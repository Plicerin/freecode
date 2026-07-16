import type { Provider, ChatRequest, ChatMessage, ToolCall, TokenUsage, ImagePart } from "../providers/types";
import type { Tool } from "../tools/types";
import type { PermissionEngine, ApprovalCallback } from "../permissions/modes";
import { withRetry, isRateLimitError } from "../utils/retry";
import { isRetryable } from "../providers/friendly-errors";
import { debug } from "../utils/debug";
import { toolListToSystemPrompt } from "../tools/registry";
import { ContextTracker } from "./context";
import { estimateMessagesTokens, trimToFit } from "./token-estimate";
import { overclaimWarning, editClaimWithoutChange } from "./overclaim";
import { looksLikeTextToolCall, announcedNextActionWithoutCalling } from "./text-tool-call";
import { parseImageLimit, isImageUnsupported, capImagesTo, countImages } from "./image-cap";
import { parseContextLimit } from "./context-limit";
import { isJunkResponse, isBinaryGarbage } from "./degeneration";
import { guardBinaryToolOutput } from "./tool-output";
import { resolveTool } from "../tools/resolve";
import { snapshotBeforeToolRun } from "../tools/backup";
import { getEnv } from "../utils/env";
import { summarizeConversation } from "./summarize";
import { runHooks } from "./hooks";
import { runVerify, verifyCoversChanges, type VerifyPlan } from "./verify";
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
  /** Persistent cross-session memory block (Honcho representation), appended to
   *  the system prompt. Recalled once per session by the REPL and passed in. */
  memoryContext?: string;
  /** Called when a context-overflow 400 reveals the model's REAL usable window
   *  (tokens). The REPL remembers it so later turns size compaction correctly
   *  instead of re-learning the same limit each turn. */
  onContextLimit?: (limitTokens: number) => void;
}

// How many times, per turn, to shrink+retry after a context-overflow 400 before
// giving up (a single message genuinely bigger than the window can't be fit).
const MAX_CONTEXT_HEALS = 4;

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
  // Drop any junk assistant scraps (a bare "')" etc.) the model emitted when it
  // degenerated in a PRIOR turn. Re-sending them poisons this turn — the model
  // parrots its own junk in a self-reinforcing loop that never recovers. They
  // carry no tool calls, so removing them can't orphan a tool result. This also
  // auto-heals a session that was already stuck in the loop.
  const history = (opts.history ?? []).filter(
    (m) => !(m.role === "assistant" && !(m.toolCalls && m.toolCalls.length) && (isJunkResponse(m.content) || isBinaryGarbage(m.content))),
  );
  const messages: ChatMessage[] = [
    ...history,
    { role: "user", content: opts.prompt, ...(opts.images?.length ? { images: opts.images } : {}) },
  ];
  const baseSys = opts.systemPrompt ?? toolListToSystemPrompt(tools);
  const sys = opts.memoryContext?.trim() ? `${baseSys}\n\n${opts.memoryContext.trim()}` : baseSys;

  const tracker = new ContextTracker({
    windowSize: opts.contextWindow,
    threshold: opts.contextThreshold,
  });

  // Summarize older messages by asking the provider for a concise recap.
  const summarize = (msgs: ChatMessage[]): Promise<string> =>
    summarizeConversation(opts.provider, opts.model, msgs, opts.signal);

  // Mutable: a context-overflow 400 tells us the server's REAL usable window
  // (more reliable than /props or a name guess), and we shrink to it and retry.
  let windowSize = opts.contextWindow ?? 200_000;
  const threshold = opts.contextThreshold ?? 0.8;
  // Approximate live context size = tokens sent+produced on the most recent
  // turn (the whole history is re-sent each turn, so this tracks the window).
  let contextTokens = 0;

  let total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  let turns = 0;
  let aborted = false;
  let lastTurnToolCalls = 0; // tool-call count of the most recent turn (outer scope)
  let producedText = false; // did the model say anything useful at all this run?
  // Cold-load retry: a freshly-loaded local model (e.g. Ollama after a long
  // idle) often returns an empty first turn (end_turn, no content); the
  // immediate retry succeeds. Burn this once per run — a model that keeps
  // coming back empty is stuck, and we want that surfaced, not papered over.
  let coldStartRetryUsed = false;
  // Per-request image cap for models that reject >N images (learned from the
  // provider's own 400, then applied proactively for the rest of the session).
  let imageLimit: number | null = null;

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
  let verifyUncovered = false; // changed files fall outside the check's scope (e.g. a standalone HTML)
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
  // Loop guard for the uncapped default: the failure breaker only catches FAILING
  // tools. A model can also wedge on a SUCCEEDING one — re-reading the same file or
  // re-running the same passing command forever, burning tokens with no cap. Trip
  // when the identical (tool, args) call repeats back-to-back. Intervening different
  // calls reset it, so legit read→edit→read cycles never trip.
  const MAX_IDENTICAL_CALLS = 10;
  let identicalCallKey = "";
  let identicalCallCount = 0;

  // Provenance ledger — machine-derived facts about what the agent really did.
  const led = { wrote: [] as string[], edited: [] as string[], read: 0, ran: [] as string[], searched: 0, viewed: 0, other: [] as string[] };

  // A non-positive maxTurns means UNCAPPED: run until the model finishes a turn
  // without tool calls (a clean "done") or the failure circuit-breaker trips. The
  // 8-consecutive-failures breaker + degeneration detection remain the backstops.
  const turnsCapped = opts.maxTurns > 0;
  while (!turnsCapped || turns < opts.maxTurns) {
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
          const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`);
          const freed = Math.max(0, result.beforeTokens - result.afterTokens);
          opts.onEvent({
            type: "compacted",
            text: `Context auto-compacted: summarized ${result.removedCount} older messages — ~${fmt(result.beforeTokens)} → ~${fmt(result.afterTokens)} tokens (freed ~${fmt(freed)}).`,
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
    // Guarantee tool_call/tool_result pairing before sending. Compaction (just
    // above) or a resumed-but-corrupted history can otherwise orphan a call and
    // make the provider reject every request. Then, if we've learned this model's
    // per-request image cap, apply it proactively so we don't re-trip the 400.
    let sentMessages = sanitizeToolPairing(messages);
    if (imageLimit !== null) sentMessages = capImagesTo(sentMessages, imageLimit);
    const req: ChatRequest = {
      model: opts.model,
      system: sys,
      messages: sentMessages,
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
    let imageCapTried = false;
    let contextHeals = 0; // context-overflow self-heals used this turn
    for (;;) {
     try {
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
      break; // stream consumed successfully
     } catch (err) {
      // Self-heal an image-rejection 400: either a per-request COUNT limit ("at
      // most N images") or a NO-VISION model that rejects image content outright
      // (DeepSeek: "unknown variant `image_url`"). Learn it, cap the conversation
      // to the allowed count (0 = strip all), and retry — stripping `messages` (not
      // just req.messages) so the image can't re-poison every later turn. Only when
      // nothing was emitted (a clean request-time reject).
      const imgLimit = !emitted && !imageCapTried
        ? (parseImageLimit(err) ?? (isImageUnsupported(err) ? 0 : null))
        : null;
      if (imgLimit !== null) {
        imageCapTried = true;
        imageLimit = imgLimit; // sticks for the rest of the run
        const had = countImages(messages);
        const noVision = imgLimit === 0;
        const note = noVision ? "[image not sent — this model has no vision; switch to a vision-capable model to view it]" : undefined;
        messages.splice(0, messages.length, ...capImagesTo(messages, imgLimit, note));
        req.messages = capImagesTo(sanitizeToolPairing(messages), imgLimit, note);
        opts.onEvent({ type: "compacted", text: noVision
          ? `${opts.model} has no vision — removed ${had} image(s) from the context (kept as text notes) and retried. Use a vision-capable model to see images.`
          : `${opts.model} accepts at most ${imgLimit} image(s) per request — kept the most recent ${Math.min(imgLimit, had)}, dropped ${Math.max(0, had - imgLimit)}, and retried.` });
        continue; // retry the stream with the capped request
      }

      // Self-heal a CONTEXT OVERFLOW: the server just told us its REAL usable
      // window (llama.cpp: "exceeds the available context size (64000 tokens)").
      // /props can overstate the window and our char/4 estimate can undercount the
      // real tokenizer, so trust the server's number: shrink to it, compact/trim
      // the conversation to fit, and retry — instead of dead-ending on the 400.
      const ctxLimit = !emitted ? parseContextLimit(err) : null;
      if (ctxLimit !== null && contextHeals < MAX_CONTEXT_HEALS && messages.length > 1) {
        contextHeals += 1;
        // Each repeat shrinks a bit more (0.9^n) to absorb estimate/tokenizer drift
        // and leave room for the reply, converging instead of re-tripping the 400.
        const target = Math.floor(ctxLimit * Math.pow(0.9, contextHeals));
        windowSize = Math.max(2048, Math.min(windowSize, target));
        opts.onContextLimit?.(ctxLimit); // remember it for later turns in this run
        const reserve = Math.min(8192, Math.max(512, Math.floor(windowSize * 0.05)));
        try {
          const r = await tracker.compact(messages, summarize); // summarize the middle
          if (r.removedCount > 0) messages.splice(0, messages.length, ...r.messages);
        } catch { /* fall through to the hard trim */ }
        const fit = trimToFit(messages, sys, Math.max(0, windowSize - reserve)); // drop oldest if a fat tail remains
        if (fit.dropped > 0) messages.splice(0, messages.length, ...sanitizeToolPairing(fit.messages));
        req.messages = sanitizeToolPairing(messages);
        if (imageLimit !== null) req.messages = capImagesTo(req.messages, imageLimit);
        opts.onEvent({ type: "compacted", text: `Server context limit is ${ctxLimit.toLocaleString()} tokens — compacted to fit and retrying.` });
        continue; // retry the stream with the shrunk request
      }

      // A user interrupt (ESC) surfaces as a throw here — let it propagate so the
      // REPL shows "Interrupted" and drops the turn the user chose to stop.
      if (opts.signal?.aborted) throw err;
      // Otherwise the stream FAILED involuntarily (e.g. openai-compat THROWS when
      // its idle watchdog fires mid-stream, AFTER partial output). Don't discard
      // the turn by re-throwing: surface the error and end gracefully so the
      // partial assistant text in `turnText` is preserved in `messages` (the
      // caller persists it). Otherwise a follow-up "continue" has no trace of what
      // was being generated and the model asks "continue what?".
      opts.onEvent({ type: "error", error: String((err as { message?: string })?.message ?? err) });
      sawError = true;
      aborted = true;
      break; // stop retrying; fall through to the single assistant push below
     }
    }

    // One assistant message per turn (the cold-load pop below depends on this
    // single push having happened when !sawError). Skip it ONLY when the turn
    // errored before producing anything — an empty, errored assistant message can
    // break the next request; a partial (turnText non-empty) is always kept so
    // "continue" retains what was being generated.
    if (turnText || turnToolCalls.length > 0 || !sawError) {
      messages.push({ role: "assistant", content: turnText, toolCalls: turnToolCalls });
    }
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
    } else if (turnToolCalls.length === 0 && (isJunkResponse(turnText) || isBinaryGarbage(turnText))) {
      // A junk scrap ("')") OR replacement-char garbage ("0�0�0") with no tool
      // call — the model has degenerated (a trivial scrap after dense/repetitive
      // input like a disassembly dump, or binary noise after raw bytes like a PDF
      // entered the context). It's filtered from FUTURE turns by the history filter
      // above; pop it from THIS run's context too, surface it clearly, and STOP
      // instead of looping "continue" and re-feeding the garbage.
      messages.pop();
      const binary = isBinaryGarbage(turnText);
      const shown = turnText.trim().replace(/[^\x20-\x7E]/g, "�").slice(0, 24);
      opts.onEvent({ type: "error", error: binary
        ? `⚠ The model returned only non-text garbage ("${shown}") — it has degenerated, typically after raw binary (a PDF/ROM/image read as text) poisoned the context. freecode won't feed that back in. Start fresh with /new, /compact to shrink the context, or switch models (/model).`
        : `⚠ The model returned only "${turnText.trim()}" — no usable answer. It has degenerated (common when a local model is fed dense/repetitive input, e.g. a disassembly dump). freecode won't feed that junk back into the context. Start fresh with /new, /compact to shrink the context, or switch models (/model).` });
      aborted = true;
      break;
    } else if (turnToolCalls.length === 0 && !turnText.trim() && !sawError && !producedText) {
      // Cold-load retry (silent one-shot). A freshly-loaded local model
      // (Ollama after a long idle, llama-server first hit) often returns an
      // empty first turn; the immediate retry returns real output. Burned
      // once per run — a model that keeps returning empty is stuck, not
      // cold, and should surface. Doesn't bump the turn budget (transport
      // blip, not model truncation). Only fires on a TRULY empty first
      // attempt (no text, no tool call, no error, no previous text this run,
      // signal still live) — anything else is a model response, not a load
      // race.
      if (!coldStartRetryUsed && !opts.signal?.aborted && !aborted) {
        coldStartRetryUsed = true;
        // INVARIANT: exactly ONE `messages.push({ role: "assistant", ... })`
        // happens above this branch, immediately after the stream block closes,
        // and no other code path between stream-end and here pushes an assistant
        // message. Pop it so the retry reasons over the last REAL assistant turn,
        // not this transport-blip ghost. If a future refactor adds another push
        // between the stream block and this branch (e.g. an intermediate
        // tool-result backfill), this pop will tear the wrong message and the
        // retry will seesaw — audit stream-end → empty-turn branch as one unit
        // before touching either.
        messages.pop();
        logActivity(`COLD-LOAD retry: ${opts.model} returned empty on first turn — re-issuing silently.`);
        turns -= 1; // not a real turn
        continue;
      }
      // Only flag a TRULY empty run — not a benign empty turn after the model
      // already gave a real answer (which is just it having nothing more to add).
      opts.onEvent({ type: "error", error: "⚠ The model returned an empty response — the turn ended without text or a tool call. This is usually the model, not freecode." });
    }

    if (turnToolCalls.length === 0) {
      // The model announced a next step in prose ("I'll check X") but didn't emit
      // the tool call, then ended its turn — the "stops mid-task, needs 'continue
      // continue'" failure on weaker local models (the same gemma keeps going in
      // other CLIs). Instead of surrendering the turn, nudge it to ACT. Bounded by
      // the auto-continue budget (which resets the moment it actually acts), and
      // harmless on a false positive — a finished model just confirms it's done.
      // Skipped when a verify is pending (handled just below) or the turn was empty
      // (that's the genuinely-stuck case warned about above).
      if (!opts.signal?.aborted
          && autoContinues < MAX_AUTO_CONTINUE
          && !(verifyEnabled && changed)
          && (announcedNextActionWithoutCalling(turnText) || looksLikeTextToolCall(turnText))) {
        autoContinues += 1;
        messages.push({ role: "user", content: "You described a next step but didn't run it — your turn ended without a tool call. If there's more to do, CALL THE TOOL now instead of describing it. If you're genuinely finished, say so in one short line." });
        opts.onEvent({ type: "compacted", text: `The model announced a step but didn't run it — nudging it to continue (${autoContinues}/${MAX_AUTO_CONTINUE})…` });
        continue;
      }
      // The agent is done talking. Earn the "done": if it changed files, run
      // the verify gate; on failure, feed it back and let it self-correct.
      if (verifyEnabled && changed && verifyAttempts < MAX_VERIFY && !opts.signal?.aborted) {
        const plan = opts.verifyPlan!;
        // Relevance gate: a build/typecheck/test only VERIFIES a change if it
        // actually compiles/loads a changed file. If every changed file is a
        // standalone asset the check never touches (a self-contained .html game,
        // a loose .css), running it would "pass" while proving nothing about the
        // edit — the tic-tac-toe trap. Refuse to credit it; end honestly unverified.
        const changedPaths = [...led.wrote, ...led.edited];
        if (!verifyCoversChanges(changedPaths, process.cwd())) {
          verifyUncovered = true;
          logActivity(`VERIFY skipped — no changed file is in scope of ${plan.commands.join(" && ")} (changed: ${changedPaths.join(", ")})`);
          opts.onEvent({ type: "verify", text: `⚠ Not verified — \`${plan.commands.join(" && ")}\` doesn't cover the changed file(s). Open/run them to confirm.` });
          break;
        }
        verifyAttempts += 1;
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
      // Resolve the called name tolerantly — case + common cross-framework
      // aliases (Write→FileWrite, shell→Bash, …) — so a model doesn't burn a turn
      // on "tool not found" just because it used its trained name for the tool.
      const tool = resolveTool(tools, call.name);
      if (!tool) {
        const restricted = opts.restrictedToolNames?.includes(call.name);
        const msg = restricted
          ? `${call.name} is unavailable in plan mode (read-only). Don't try to run commands or edit files — investigate with FileRead/Grep/Glob and PROPOSE a plan. The user runs /plan to exit plan mode and let you act.`
          : `Error: tool "${call.name}" not found. Available tools (use these EXACT names): ${tools.map((t) => t.name).join(", ")}.`;
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
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        const hint = tool.correctionHint?.(call.arguments);
        const errMsg = `Invalid arguments to ${tool.name}: ${issues}.${hint ? ` ${hint}` : ""}`;
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
      // Shadow-copy anything this call is about to overwrite, BEFORE it runs —
      // covers FileWrite/FileEdit and any file a Bash command writes (e.g. a raw
      // `node -e "...writeFileSync..."`). Fail-soft; never blocks the tool.
      snapshotBeforeToolRun(tool.name, parsed.data, process.cwd());
      const t0 = Date.now();
      const result = await tool.run(parsed.data, { cwd: process.cwd(), signal: opts.signal });
      const durationMs = Date.now() - t0;
      // Scrub secrets from tool output BEFORE it touches the model, transcript,
      // or session log. A `Get-ChildItem Env:` or `cat .env` can spill live keys.
      const red = redactSecrets(result.output);
      result.output = red.text;
      // Then swap out binary/non-text output (a PDF/ROM read via the shell) for a
      // note — raw bytes decode to U+FFFD garbage that degenerates the model. This
      // is FileRead's binary guard applied at the tool-output boundary, so it also
      // covers Bash `cat`/`node -e readFileSync` that route around FileRead.
      const binGuard = guardBinaryToolOutput(result.output);
      result.output = binGuard.text;
      if (binGuard.suppressed) logActivity(`TOOL ${tool.name} output was binary/non-text → suppressed to protect the context`);
      if (result.error) result.error = redactSecrets(result.error).text;
      const payload = (result.ok ? result.output : `Error: ${result.error ?? "unknown"}\n${result.output}`) +
        (red.count > 0 ? `\n[freecode redacted ${red.count} secret(s) from this output]` : "");
      if (result.ok) consecutiveFailures = 0;
      else { consecutiveFailures += 1; lastFailureMsg = `${tool.name}: ${result.error ?? result.output.slice(0, 160)}`; }
      // Track back-to-back identical calls (succeeding or not) for the loop guard.
      const callKey = `${call.name} ${JSON.stringify(call.arguments)}`;
      if (callKey === identicalCallKey) identicalCallCount += 1;
      else { identicalCallKey = callKey; identicalCallCount = 1; }
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
    // Loop guard: the same call repeated back-to-back with no change → stuck.
    if (identicalCallCount >= MAX_IDENTICAL_CALLS) {
      const note = `Stopped: the same tool call repeated ${identicalCallCount}× in a row with no change — the model is looping, not making progress. Try a different approach or /new.`;
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
  if (!aborted && turnsCapped && lastTurnToolCalls > 0 && turns >= opts.maxTurns) {
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
      believed.push(verifyUncovered
        ? `changed ${changedCount} file(s) the configured check doesn't cover (e.g. a standalone HTML) — unverified; open/run them to confirm`
        : `changed ${changedCount} file(s) without running checks — unverified`);
    }

    // Two complementary honesty guards. Overclaim catches a sweeping "all done"
    // claim that the evidence doesn't back (no verification, or a failing check).
    // The contradiction-guard catches a more specific lie: the final reply
    // describes an edit ("I edited the file", "the config is updated") but the
    // ledger shows zero files changed. Layered priority: overclaim wins (it's
    // broader); contradiction only surfaces when no sweeping claim was made.
    const finalText = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
    const claimWarn = overclaimWarning(finalText, { changedCount, verifiedCount: verified.length, anyFailed });
    const contradictWarn = editClaimWithoutChange(finalText, changedCount);
    const warning = (claimWarn ?? contradictWarn) ?? undefined;

    if (observed.length || verified.length || believed.length || warning) {
      logActivity(`LEDGER verified=[${verified.join("; ")}] observed=[${observed.join("; ")}] believed=[${believed.join("; ")}]${warning ? ` warning=[${warning}]` : ""}`);
      opts.onEvent({ type: "ledger", ledger: { verified, observed, believed, warning } });
    }
  }

  await runHooks("Stop", opts.hooks, { event: "Stop", turns, aborted, cwd: process.cwd() }, undefined, opts.signal);
  opts.onEvent({ type: "done", reason: aborted ? "aborted" : turnsCapped && turns >= opts.maxTurns ? "max_turns" : "end_turn" });
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
  // Package-manager script runs: npm/pnpm/yarn/bun [run] <known-check>. Also
  // covers scoped workflows like `npm run build:prod` and `tauri:build` —
  // a Tauri app's npm-script that the strict dictionary missed.
  const KNOWN_CHECK = "build|test|typecheck|type-check|lint|check|verify|tsc|compile|bundle|package|audit|validate|coverage";
  // Known check verb, with optional :suffix or -suffix (e.g. build:prod, type-check:strict).
  const pm = new RegExp(`\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:${KNOWN_CHECK})(?:[:-][a-z0-9_-]+)?\\b`).exec(cmd);
  if (pm) return pm[0].trim();
  // <workflow>:<check> (e.g. tauri:build, workspace:test). Subject prefix is
  // any word — guarded by the known check-verb suffix on the right side.
  const wfColon = new RegExp(`\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?\\w+[:-](?:${KNOWN_CHECK})\\b`).exec(cmd);
  if (wfColon) return wfColon[0].trim();
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
