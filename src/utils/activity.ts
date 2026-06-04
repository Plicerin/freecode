// Activity log for auditing verification against real-world runs. Appends a
// timestamped, secret-redacted line for each command, verify run, provenance
// ledger, and confidence transition — a readable trail of "what did it do, and
// what did it actually confirm." ON by default during active development;
// toggle with /log, or set FREECODE_ACTIVITY_LOG=0 (or false/off) to disable,
// =<path> to redirect.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { redactSecrets } from "./redact";

// On by default for real runs (redacted; toggle with /log), but OFF under the
// test runner so the suite never writes to the user's real activity log.
let enabled = process.env.NODE_ENV !== "test";
let logPath = join(os.homedir(), ".freecode", "activity.log");

const envVal = process.env.FREECODE_ACTIVITY_LOG;
if (envVal !== undefined) {
  const v = envVal.toLowerCase();
  if (v === "0" || v === "false" || v === "off") {
    enabled = false;
  } else {
    enabled = true;
    if (envVal !== "1" && v !== "true") logPath = envVal;
  }
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
