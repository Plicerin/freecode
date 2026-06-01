import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

export const HOME = homedir();
export const APP_DIR = join(HOME, ".freecode");
export const PROJECTS_DIR = join(APP_DIR, "projects");
export const SETTINGS_PATH = join(APP_DIR, "settings.json");
export const PROFILE_PATH = resolve(process.cwd(), ".freecode-profile.json");

export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[:\\/]+/g, "-");
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
