// /goal — autonomous iteration toward an objective. freecode runs cycles (each a
// full agent turn). The model self-reports DONE/CONTINUE on its last line, but a
// DONE is NOT taken on the model's word: the REPL orchestrator runs the project's
// real verification commands and only accepts DONE if they pass — otherwise the
// failure becomes the next cycle's task (goalVerifyFailedPrompt). The loop also
// stops if cycles stop making progress (no tool calls), or at the cycle cap, or on
// interrupt. The orchestration lives in the REPL; the parsing/prompting/decision
// here are pure so they're unit-tested.

export const GOAL_MAX_DEFAULT = 12;

export type GoalStatus = "done" | "continue" | "unknown";

/** Read the model's self-reported status from its final message. It's asked to
 *  end with "GOAL: DONE" or "GOAL: CONTINUE"; we look at the tail first. */
export function goalStatus(text: string): GoalStatus {
  const tail = text.split(/\r?\n/).slice(-6).join("\n");
  if (/GOAL:\s*DONE\b/i.test(tail)) return "done";
  if (/GOAL:\s*CONTINUE\b/i.test(tail)) return "continue";
  if (/GOAL:\s*DONE\b/i.test(text)) return "done"; // anywhere, as a fallback
  if (/GOAL:\s*CONTINUE\b/i.test(text)) return "continue";
  return "unknown";
}

const FRAME = [
  "You are working AUTONOMOUSLY toward a goal across multiple cycles — no one will reply between cycles.",
  "Do real work this cycle (use your tools; prefer verifying). Then make the LAST line of your message exactly one of:",
  "  GOAL: DONE       — the goal is fully achieved (and, where possible, verified)",
  "  GOAL: CONTINUE   — more work remains",
  "Only report DONE when it is genuinely complete. Keep each cycle focused on the next concrete step.",
].join("\n");

/** The prompt for cycle `iteration` (0-based). Cycle 0 states the goal; later
 *  cycles continue it. Both demand the trailing status marker. */
export function goalPrompt(objective: string, iteration: number): string {
  if (iteration === 0) return `GOAL: ${objective}\n\n${FRAME}`;
  return `Continue toward the GOAL: ${objective}\n\nReview what's done, take the next concrete step, then end with GOAL: DONE or GOAL: CONTINUE.\n\n${FRAME}`;
}

/** The next-cycle prompt when the model claimed DONE but the project's
 *  verification command FAILED. The failing command is the concrete next step —
 *  the model doesn't get to declare victory while the checks are red. */
export function goalVerifyFailedPrompt(objective: string, failedCommand: string, output: string): string {
  const tail = (output || "(no output)").trim().slice(-1500);
  return [
    "You reported GOAL: DONE — but it is NOT done. The project's verification command failed:",
    `  $ ${failedCommand}`,
    "",
    tail,
    "",
    "Fix the underlying CAUSE so that command passes — do the work with your tools, don't just claim it, and never weaken or skip the check to make it green.",
    "",
    `GOAL: ${objective}`,
    FRAME,
  ].join("\n");
}

export type GoalDecision = "done" | "continue" | "stop-max" | "stop-aborted";

/** Decide whether to loop after a completed cycle. `completed` is the number of
 *  cycles finished so far (1-based). */
export function goalDecision(opts: { status: GoalStatus; aborted: boolean; completed: number; max: number }): GoalDecision {
  if (opts.aborted) return "stop-aborted";
  if (opts.status === "done") return "done";
  if (opts.completed >= opts.max) return "stop-max";
  return "continue"; // "continue" or "unknown" → keep going (bounded by max)
}
