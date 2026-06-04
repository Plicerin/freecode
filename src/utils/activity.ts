// Opt-in activity log for auditing verification against real-world runs. When
// enabled, freecode appends a timestamped line for each command, verify run,
// provenance ledger, and confidence transition — a readable trail of "what did
// it do, and what did it actually confirm." Toggle with /log (or the
// FREECODE_ACTIVITY_LOG env var = "1" for the default path, or a path).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { redactSecrets } from "./redact";

let enabled = false;
let logPath = join(os.homedir(), ".freecode", "activity.log");

const envVal = process.env.FREECODE_ACTIVITY_LOG;
if (envVal) {
  enabled = true;
  if (envVal !== "1" && envVal.toLowerCase() !== "true") logPath = envVal;
}

export function setActivityLog(on: boolean, path?: string): { on: boolean; path: string } {
  enabled = on;
  if (path) logPath = path;
  return { on: enabled, path: logPath };
}

export function activityState(): { on: boolean; path: string } {
  return { on: enabled, path: logPath };
}

/** Append one timestamped line. Logging must never throw into the app. */
export function logActivity(line: string): void {
  if (!enabled) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    // Redact secrets from EVERY line — a pasted key in a USER prompt or a tool
    // arg must never land in the log on disk.
    appendFileSync(logPath, `${new Date().toISOString()}  ${redactSecrets(line).text}\n`);
  } catch {
    /* never let logging break a run */
  }
}
