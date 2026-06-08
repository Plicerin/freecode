// Remember the provider/model from the last session so freecode reopens where you
// left off instead of auto-selecting (which lands on whatever has a key, e.g.
// openai). Stored as a small machine-managed file — kept separate from
// settings.json so it never clobbers a hand-edited (possibly commented) config.
// It's the LOWEST-priority default: an explicit --provider/--model, a project
// profile, env vars, or settings.json all still win.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { APP_DIR } from "../utils/paths";
import type { ProviderId } from "./schema";

export interface LastSession {
  provider?: ProviderId;
  model?: string;
}

function defaultPath(): string {
  return join(APP_DIR, "last-session.json");
}

export function readLastSession(path: string = defaultPath()): LastSession {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LastSession;
    return { provider: parsed.provider, model: parsed.model };
  } catch {
    return {};
  }
}

export function writeLastSession(s: LastSession, path: string = defaultPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ provider: s.provider, model: s.model }, null, 2));
  } catch {
    /* remembering must never break a run */
  }
}
