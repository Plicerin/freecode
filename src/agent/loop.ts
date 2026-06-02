import type { Provider, ChatRequest, ChatMessage, ToolCall, TokenUsage, ImagePart } from "../providers/types";
import type { Tool } from "../tools/types";
import type { PermissionEngine, ApprovalCallback } from "../permissions/modes";
import { withRetry, isRateLimitError } from "../utils/retry";
import { debug } from "../utils/debug";
import { toolListToSystemPrompt } from "../tools/registry";
import { ContextTracker } from "./context";
import { summarizeConversation } from "./summarize";
import { runHooks } from "./hooks";
import { runVerify, type VerifyPlan } from "./verify";
import type { HooksConfig } from "../config/schema";

export interface AgentEvent {
  type: "text_delta" | "tool_call" | "tool_result" | "thinking_delta" | "usage" | "done" | "error" | "approval_needed" | "compacted" | "verify";
  text?: string;
  call?: ToolCall;
  result?: { id: string; output: string; ok: boolean; durationMs: number };
  usage?: TokenUsage;
  error?: string;
  reason?: string;
  tool?: string;
  argsSummary?: string;
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
  /** Auto-verify gate: run these checks after a file-changing turn. */
  verifyPlan?: VerifyPlan;
  verifyMode?: "off" | "on" | "strict";
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<{ turns: number; usage: TokenUsage; aborted: boolean; messages: ChatMessage[] }> {
  const tools = opts.tools;
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

  // Auto-verify gate state.
  const verifyMode = opts.verifyMode ?? "off";
  const verifyEnabled = verifyMode !== "off" && (opts.verifyPlan?.commands.length ?? 0) > 0;
  const MAX_VERIFY = 3;
  let changed = false; // a file-mutating tool succeeded this task
  let verifyAttempts = 0;
  let verifyFailed = false;

  while (turns < opts.maxTurns) {
    turns += 1;
    if (opts.signal?.aborted) { aborted = true; break; }

    // Auto-compact when the context window fills up (SPEC V14).
    if (contextTokens >= windowSize * threshold && messages.length > 4) {
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
    const req: ChatRequest = {
      model: opts.model,
      system: sys,
      messages,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.schema as never,
        permission: t.permission,
        parameters: t.parameters,
      })),
      stream: true,
      maxTokens: 8192,
      enablePromptCache: opts.enablePromptCache,
      enableExtendedThinking: opts.enableExtendedThinking,
      signal: opts.signal,
    };

    let turnText = "";
    let turnToolCalls: ToolCall[] = [];
    let sawError = false;
    let emitted = false;

    // Stream events live (dispatch as they arrive) so the UI can render tokens
    // incrementally. Retry only applies before the first event (e.g. a 429 at
    // connection time); once streaming has started we don't re-run.
    await withRetry(
      async () => {
        turnText = "";
        turnToolCalls = [];
        sawError = false;
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
      { shouldRetry: (err) => !emitted && isRateLimitError(err) },
    );

    messages.push({ role: "assistant", content: turnText, toolCalls: turnToolCalls });

    if (sawError) break;
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
          opts.onEvent({ type: "verify", text: `✓ Verified — ${res.ranCommands.join(" && ")} passed.` });
          verifyFailed = false;
          break;
        }
        opts.onEvent({ type: "verify", text: `✗ Verification failed (${res.failedCommand}) — fixing…` });
        verifyFailed = true;
        changed = false;
        messages.push({ role: "user", content: `Verification failed running \`${res.failedCommand}\`:\n\n${res.output.slice(-3000)}\n\nFix the underlying cause, then we'll re-check.` });
        continue;
      }
      break;
    }

    // Execute tools sequentially; could parallelize later
    const pendingImages: ImagePart[] = [];
    for (const call of turnToolCalls) {
      if (opts.signal?.aborted) { aborted = true; break; }
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        const result = { id: call.id, output: "", ok: false, durationMs: 0 };
        messages.push({ role: "tool", toolCallId: call.id, content: `Error: tool ${call.name} not found` });
        opts.onEvent({ type: "tool_result", result: { ...result, output: `Error: tool ${call.name} not found` } });
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
      const payload = result.ok ? result.output : `Error: ${result.error ?? "unknown"}\n${result.output}`;
      if (result.ok && (tool.name === "FileWrite" || tool.name === "FileEdit")) changed = true;
      messages.push({ role: "tool", toolCallId: call.id, content: payload });
      opts.onEvent({ type: "tool_result", result: { id: call.id, output: payload, ok: result.ok, durationMs } });
      // PostToolUse hook — observe the result (side effects only; can't block).
      await runHooks("PostToolUse", opts.hooks, { event: "PostToolUse", tool: tool.name, arguments: parsed.data, result: { ok: result.ok, output: result.output.slice(0, 4000) }, cwd: process.cwd() }, tool.name, opts.signal);
      // Collect any images the tool returned (e.g. ViewImage); they're surfaced
      // AFTER all tool results so the tool-response block stays contiguous
      // (providers reject a user message interleaved between tool results).
      if (result.images && result.images.length > 0) pendingImages.push(...result.images);
    }

    // Feed collected tool images back as a single user message so the model sees them.
    if (pendingImages.length > 0) {
      messages.push({ role: "user", content: `[${pendingImages.length} image(s) loaded and now visible]`, images: pendingImages });
    }

    if (aborted) break;
  }

  if (verifyFailed && !aborted) {
    opts.onEvent({ type: "verify", text: `⚠ Checks still failing after ${verifyAttempts} attempt(s) — left as-is for you to review.` });
  }
  await runHooks("Stop", opts.hooks, { event: "Stop", turns, aborted, cwd: process.cwd() }, undefined, opts.signal);
  opts.onEvent({ type: "done", reason: aborted ? "aborted" : turns >= opts.maxTurns ? "max_turns" : "end_turn" });
  return { turns, usage: total, aborted, messages };
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
