import { existsSync, readFileSync } from "node:fs";
import { PROFILE_PATH } from "../utils/paths";
import { ProfileSchema, type Profile } from "./schema";
import { debug } from "../utils/debug";

export function loadProfile(path: string = PROFILE_PATH): Profile {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw);
    const result = ProfileSchema.safeParse(data);
    if (!result.success) {
      debug.warn(`profile validation failed: ${path}`, result.error.flatten());
      return {};
    }
    return result.data;
  } catch (err) {
    debug.warn(`failed to read profile ${path}`, String(err));
    return {};
  }
}
