// Serialised tool-approval prompts. The REPL can be asked to approve several
// tools at the SAME time — a workflow stage fans out to parallel sub-agents, each
// of which may hit a tool that needs confirmation. A single resolver slot let the
// second request overwrite the first, orphaning its promise so the stage's
// Promise.all waited forever (the /ultraplan "hang"). This queue serialises them:
// one prompt is shown at a time (the head), the rest wait their turn, and a flush
// denies the whole batch at once so a single `esc` unwinds the fan-out.
//
// The queue is pure (no React) so the clobber-resistance is unit-testable; the
// REPL wires `onHeadChange` to setPending to drive what's on screen.
import type { ApprovalRequest, ApprovalDecision } from "../permissions/modes";

export interface ApprovalQueue {
  /** Enqueue a request; the returned promise resolves when this one is decided. */
  enqueue(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** The request currently shown (head of the queue), or null if none. */
  head(): ApprovalRequest | null;
  /** Decide the head and advance to the next; returns the new head (or null). */
  resolveHead(decision: ApprovalDecision): ApprovalRequest | null;
  /** Resolve every queued request with one decision (default deny) and clear. */
  flush(decision?: ApprovalDecision): void;
  /** How many requests are queued (including the head). */
  size(): number;
}

export function createApprovalQueue(onHeadChange: (req: ApprovalRequest | null) => void): ApprovalQueue {
  const q: Array<{ req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }> = [];
  return {
    enqueue(req) {
      return new Promise<ApprovalDecision>((resolve) => {
        q.push({ req, resolve });
        if (q.length === 1) onHeadChange(req); // first in line — show it now
      });
    },
    head() {
      return q[0]?.req ?? null;
    },
    resolveHead(decision) {
      const head = q.shift();
      head?.resolve(decision);
      const next = q[0]?.req ?? null;
      onHeadChange(next);
      return next;
    },
    flush(decision = "deny") {
      const all = q.splice(0, q.length);
      for (const { resolve } of all) resolve(decision);
      onHeadChange(null);
    },
    size() {
      return q.length;
    },
  };
}
