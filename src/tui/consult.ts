// "/consult" brings a SECOND model into the live session to supervise, validate,
// or answer — a different provider/model than the one driving the session. It
// runs as a full agent (its own tools), seeded with the conversation so far, and
// its turn threads back INTO the conversation so the primary agent sees it.

/** Providers offerable as a supervisor (implemented ones; excludes the
 *  unimplemented bedrock/vertex and the mock). Order is picker order. */
export const CONSULT_PROVIDERS = [
  "anthropic", "openai", "gemini", "github-models", "openrouter",
  "nim", "ollama", "lmstudio", "llama-server",
] as const;

/** The user turn the supervisor receives. The session transcript is supplied as
 *  history; this frames WHO the supervisor is and what to do — critically, to
 *  verify against the real code/commands rather than trusting the transcript. */
export function supervisorPrompt(task: string): string {
  const t = task.trim();
  return [
    "You are a SECOND, independent model brought into an ongoing coding session as a supervisor / reviewer.",
    "Everything before this message is the work of the PRIMARY agent and the user — review it CRITICALLY and do not assume its claims are correct.",
    "You have full tool access: read files, grep, run the build/tests, and if you find a genuine problem you may fix it.",
    "Verify against the actual code and command output, NOT the transcript's claims.",
    "",
    `Supervisor task: ${t || "Review the work so far for correctness, bugs, and anything the primary agent overclaimed or missed."}`,
    "",
    "Report concisely: what you checked, what you found (with evidence — the file/line or the command output), and any fixes you made. If it's all sound, say so plainly.",
  ].join("\n");
}

/** One-line banner echoed into history when a consult starts. */
export function consultBanner(providerId: string, model: string, task: string): string {
  const t = task.trim();
  return `🧐 Consulting supervisor ${providerId}:${model}${t ? ` — ${t}` : ""}`;
}
