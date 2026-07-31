import { redactSecrets } from "./redact";

const enabled = process.env.CLAUDE_DEBUG === "1";

export function formatDebugLine(level: string, msg: string, extra?: unknown): string {
  const line = extra === undefined
    ? `[freecode][${level}] ${msg}`
    : `[freecode][${level}] ${msg} ${JSON.stringify(extra)}`;
  return redactSecrets(line).text;
}

function emit(level: string, msg: string, extra?: unknown): void {
  if (!enabled) return;
  process.stderr.write(formatDebugLine(level, msg, extra) + "\n");
}

export const debug = {
  log: (msg: string, extra?: unknown) => emit("log", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
  isEnabled: () => enabled,
};
