// Sub-agent orchestration (ROADMAP Tier A). A sub-agent is a nested run of the
// same agent loop with a fresh context, a focused task, and the same tools —
// EXCEPT it can't dispatch further sub-agents (the host hands it a toolset
// without the Agent tool), so recursion is impossible by construction. Its final
// message is the return value handed back to the orchestrator as a tool result.
import type { Provider, ChatMessage } from "../providers/types";
import type { Tool } from "../tools/types";
import type { PermissionEngine, ApprovalCallback } from "../permissions/modes";
import type { HooksConfig } from "../config/schema";
import { runAgentLoop, type AgentEvent } from "./loop";
import { toolListToSystemPrompt } from "../tools/registry";
import type { AgentType } from "./agent-types";

/** Everything a sub-agent run needs except the per-call task. Supplied lazily by
 *  the host (via a getter) so a mid-session provider/model switch is honoured. */
export interface SubAgentContext {
  provider: Provider;
  model: string;
  tools: Tool[]; // the sub-agent's toolset — MUST NOT contain the Agent tool
  permission: PermissionEngine;
  promptUser: ApprovalCallback;
  hooks?: HooksConfig;
  contextWindow?: number;
  maxTurns?: number;
}

const SUBAGENT_NOTE =
  "\n\nYou are a SUB-AGENT dispatched by an orchestrator to complete ONE focused task autonomously. " +
  "You cannot ask the orchestrator questions and you cannot dispatch further sub-agents. " +
  "You do not share the orchestrator's conversation — work only from the task you were given. " +
  "Complete the task with your tools, then make your FINAL message a concise, self-contained report " +
  "of what you found or did. That final message is your ENTIRE return value to the orchestrator, so " +
  "put the answer there — no preamble, no 'let me know if'.";

export function subAgentSystemPrompt(tools: Tool[], specialization?: string): string {
  const base = toolListToSystemPrompt(tools) + SUBAGENT_NOTE;
  return specialization ? `${base}\n\n${specialization}` : base;
}

/** Run a sub-agent to completion and return its final message. An optional
 *  agent type supplies a specialization prompt and restricts the toolset. */
export async function runSubAgent(
  opts: SubAgentContext & {
    prompt: string;
    description: string;
    agentType?: AgentType;
    signal?: AbortSignal;
    onEvent?: (e: AgentEvent) => void;
  },
): Promise<{ ok: boolean; output: string; turns: number }> {
  // A typed agent runs with only its allowlisted tools (e.g. explore = read-only).
  const tools = opts.agentType?.tools
    ? opts.tools.filter((t) => opts.agentType!.tools!.includes(t.name))
    : opts.tools;
  const result = await runAgentLoop({
    provider: opts.provider,
    tools,
    model: opts.model,
    // Sub-agents stay bounded even when the MAIN loop is uncapped (maxTurns 0):
    // they run unsupervised and can't ask for help, so a runaway is worse here. A
    // non-positive inherited value falls back to the sub-agent's own 20-turn floor.
    maxTurns: opts.maxTurns && opts.maxTurns > 0 ? opts.maxTurns : 20,
    systemPrompt: subAgentSystemPrompt(tools, opts.agentType?.systemPrompt),
    prompt: opts.prompt,
    history: [], // fresh context — sub-agents start clean
    permission: opts.permission,
    promptUser: opts.promptUser,
    signal: opts.signal,
    hooks: opts.hooks,
    contextWindow: opts.contextWindow,
    // The orchestrator owns verification; a sub-agent reports, it doesn't gate.
    verifyMode: "off",
    onEvent: (e) => opts.onEvent?.(e),
  });
  // The return value is the sub-agent's FINAL assistant message (Claude Code
  // semantics), not the concatenation of its intermediate reasoning.
  const last = [...result.messages]
    .reverse()
    .find((m: ChatMessage) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0);
  const output = (last?.content as string | undefined)?.trim() || "(sub-agent finished with no text output)";
  return { ok: !result.aborted, output, turns: result.turns };
}
