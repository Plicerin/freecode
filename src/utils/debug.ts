const enabled = process.env.CLAUDE_DEBUG === "1";

function emit(level: string, msg: string, extra?: unknown): void {
  if (!enabled) return;
  const line = extra === undefined
    ? `[openclaude][${level}] ${msg}`
    : `[openclaude][${level}] ${msg} ${JSON.stringify(extra)}`;
  process.stderr.write(line + "\n");
}

export const debug = {
  log: (msg: string, extra?: unknown) => emit("log", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
  isEnabled: () => enabled,
};
