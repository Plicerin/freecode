import { existsSync, readFileSync, watch } from "node:fs";
import { parse as parseJsonc, ParseError } from "jsonc-parser";
import { SETTINGS_PATH } from "../utils/paths";
import { debug } from "../utils/debug";
import { SettingsSchema, type Settings } from "./schema";

export function loadJsoncSettings(path: string = SETTINGS_PATH): Settings {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    debug.warn(`failed to read settings ${path}`, String(err));
    return {};
  }
  const errors: ParseError[] = [];
  const data = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    debug.warn(`jsonc parse errors in ${path}`, errors.map((e) => e.error));
  }
  const result = SettingsSchema.safeParse(data ?? {});
  if (!result.success) {
    debug.warn(`settings validation failed for ${path}`, result.error.flatten());
    return {};
  }
  return result.data;
}

export type SettingsListener = (settings: Settings) => void;

export function watchSettings(path: string = SETTINGS_PATH, listener: SettingsListener): () => void {
  if (!existsSync(path)) {
    debug.log(`settings watch: ${path} does not exist, skipping`);
    return () => {};
  }
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const handle = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const next = loadJsoncSettings(path);
      listener(next);
    }, 200);
  };
  const watcher = watch(path, { persistent: false }, handle);
  debug.log(`settings watcher armed: ${path}`);
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
}
