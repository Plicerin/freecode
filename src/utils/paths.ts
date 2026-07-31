import { homedir, platform } from "node:os";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

export const HOME = homedir();
export const APP_DIR = join(HOME, ".freecode");
export const PROJECTS_DIR = join(APP_DIR, "projects");
export const SETTINGS_PATH = join(APP_DIR, "settings.json");
export const VAULT_PATH = join(APP_DIR, "vault.json");
export const VAULT_KEY_PATH = join(APP_DIR, "vault.key");
export const PROFILE_PATH = resolve(process.cwd(), ".freecode-profile.json");

/** Historical slug retained only so existing sessions remain discoverable. It
 * is not collision-safe (`C:\\a-b` and `C:\\a\\b` produce the same value). */
export function legacyEncodeProjectPath(cwd: string): string {
  return cwd.replace(/[:\\/]+/g, "-");
}

export function canonicalProjectPath(cwd: string): string {
  const normalized = resolve(cwd).replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return isWindows() ? normalized.toLowerCase() : normalized;
}

export function encodeProjectPath(cwd: string): string {
  const canonical = canonicalProjectPath(cwd);
  const label = (basename(canonical) || "root")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40) || "project";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${label}-${hash}`;
}

export function sessionPath(cwd: string, sessionId: string): string {
  return join(PROJECTS_DIR, encodeProjectPath(cwd), `${sessionId}.jsonl`);
}

export function projectDir(cwd: string): string {
  return join(PROJECTS_DIR, encodeProjectPath(cwd));
}

export function isWindows(): boolean {
  return platform() === "win32";
}
