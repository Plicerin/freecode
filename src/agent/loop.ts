import type { Provider, ChatRequest, ChatMessage, ToolCall, StreamEvent, TokenUsage } from "../providers/types";
import type { Tool } from "../tools/types";
import type { PermissionEngine, ApprovalCallback } from "../permissions/modes";
import { withRetry } from "../utils/retry";
import { debug } from "../utils/debug";
import { toolListToSystemPrompt } from "../tools/registry";
import { ContextTracker } from "./context";

export interface AgentEvent {
  type: "text_delta" | "tool_call" | "tool_result" | "thinking_delta" | "usage" | "done" | "error" | "approval_needed" | "compacted";
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
  permission: PermissionEngine;
  promptUser: ApprovalCallback;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  contextWindow?: number;
  contextThreshold?: number;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<{ turns: number; usage: TokenUsage; aborted: boolean }> {
  const tools = opts.tools;
  const messages: ChatMessage[] = [{ role: "user", content: opts.prompt }];
  const sys = opts.systemPrompt ?? toolListToSystemPrompt(tools);

  const tracker = new ContextTracker({
    windowSize: opts.contextWindow,
    threshold: opts.contextThreshold,
  });

  // Summarize older messages by asking the provider for a concise recap.
  const summarize = async (msgs: ChatMessage[]): Promise<string> => {
    const summaryReq: ChatRequest = {
      model: opts.model,
      system: "You compress conversations. Produce a concise summary of the conversation below, preserving key facts, decisions, file paths, command results, and any unfinished tasks. Output only the summary text.",
      messages: [...msgs, { role: "user", content: "Summarize everything above concisely." }],
      stream: true,
      maxTokens: 1024,
      signal: opts.signal,
    };
    const evs = await collectStream(opts.provider.stream(summaryReq));
    return evs
      .filter((e): e is Extract<StreamEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.delta)
      .join("")
      .trim();
  };

  const windowSize = opts.contextWindow ?? 200_000;
  const threshold = opts.contextThreshold ?? 0.8;
  // Approximate live context size = tokens sent+produced on the most recent
  // turn (the whole history is re-sent each turn, so this tracks the window).
  let contextTokens = 0;

  let total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  let turns = 0;
  let aborted = false;

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
      })),
      stream: true,
      maxTokens: 8192,
      signal: opts.signal,
    };

    const events = await withRetry(async () => collectStream(opts.provider.stream(req)));
    const collected = await events;

    let turnText = "";
    const turnToolCalls: ToolCall[] = [];
    let sawError = false;

    for (const e of collected) {
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

    messages.push({ role: "assistant", content: turnText, toolCalls: turnToolCalls });

    if (sawError) break;
    if (turnToolCalls.length === 0) break;

    // Execute tools sequentially; could parallelize later
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
      const t0 = Date.now();
      const result = await tool.run(parsed.data, { cwd: process.cwd(), signal: opts.signal });
      const durationMs = Date.now() - t0;
      const payload = result.ok ? result.output : `Error: ${result.error ?? "unknown"}\n${result.output}`;
      messages.push({ role: "tool", toolCallId: call.id, content: payload });
      opts.onEvent({ type: "tool_result", result: { id: call.id, output: payload, ok: result.ok, durationMs } });
    }

    if (aborted) break;
  }

  opts.onEvent({ type: "done", reason: aborted ? "aborted" : turns >= opts.maxTurns ? "max_turns" : "end_turn" });
  return { turns, usage: total, aborted };
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

async function collectStream(s: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of s) out.push(e);
  return out;
}
