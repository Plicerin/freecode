import { EventEmitter } from "node:events";
import type { TokenUsage, ChatMessage } from "../providers/types";
import { debug } from "../utils/debug";

export interface CompactionResult {
  messages: ChatMessage[];
  removedCount: number;
  summaryTokens: number;
}

export interface ContextTrackerEvents {
  usage: (u: TokenUsage) => void;
  compacted: (r: CompactionResult) => void;
}

export class ContextTracker extends EventEmitter {
  private usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  private threshold: number;
  private windowSize: number;

  constructor(opts: { windowSize?: number; threshold?: number } = {}) {
    super();
    this.windowSize = opts.windowSize ?? 200_000;
    this.threshold = opts.threshold ?? 0.8;
  }

  record(u: TokenUsage): void {
    this.usage = {
      input: this.usage.input + u.input,
      output: this.usage.output + u.output,
      cacheRead: this.usage.cacheRead + u.cacheRead,
      cacheWrite: this.usage.cacheWrite + u.cacheWrite,
      thinking: this.usage.thinking + u.thinking,
    };
    this.emit("usage", this.usage);
  }

  totalUsed(): number {
    return this.usage.input + this.usage.output;
  }

  utilization(): number {
    return this.totalUsed() / this.windowSize;
  }

  shouldCompact(): boolean {
    return this.utilization() >= this.threshold;
  }

  /**
   * Compact by dropping oldest non-system messages and inserting a summary stub.
   * Real summary generation needs an LLM call — for now produce a stub marker.
   * The caller (agent loop) is responsible for calling the provider to summarize.
   */
  async compact(messages: ChatMessage[], summarize: (msgs: ChatMessage[]) => Promise<string>): Promise<CompactionResult> {
    if (messages.length <= 2) {
      return { messages, removedCount: 0, summaryTokens: 0 };
    }
    const head = messages[0];
    const tailCount = Math.max(2, Math.floor(messages.length * 0.3));
    const tail = messages.slice(-tailCount);
    const toSummarize = messages.slice(1, -tailCount);
    if (toSummarize.length === 0) {
      return { messages, removedCount: 0, summaryTokens: 0 };
    }
    const summary = await summarize(toSummarize);
    const summaryTokens = Math.ceil(summary.length / 4);
    const summaryMsg: ChatMessage = {
      role: "system",
      content: `[Context summary: ${summary}]`,
    };
    const next: ChatMessage[] = head ? [head, summaryMsg, ...tail] : [summaryMsg, ...tail];
    debug.log("compacted context", { removed: toSummarize.length, summaryTokens });
    const result: CompactionResult = { messages: next, removedCount: toSummarize.length, summaryTokens };
    this.emit("compacted", result);
    return result;
  }

  costUsd(): number {
    // Rough blended estimate — caller should refine per-model pricing.
    const inputCost = (this.usage.input / 1_000_000) * 3;
    const outputCost = (this.usage.output / 1_000_000) * 15;
    return inputCost + outputCost;
  }
}
