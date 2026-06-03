// The registry of hot-path benchmarks freecode races itself on. Each entry is a
// real, deterministic slice of an interactive code path — no network, no TTY —
// so the timings are stable enough for the noise band to mean something. Add to
// this list as new hot paths are identified; the harness and ledger don't change.

import { closest, editDistance } from "../utils/fuzzy";
import { loadConfig } from "../config/loader";

export interface Benchmark {
  name: string;
  why: string; // the interactive hot path this stands in for
  run: () => unknown | Promise<unknown>;
}

const COMMANDS = [
  "/model", "/new", "/resume", "/context", "/provider", "/mcp",
  "/plan", "/verify", "/help", "/compact", "/about", "/exit",
];

export const BENCHMARKS: Benchmark[] = [
  {
    name: "fuzzy:closest",
    why: "unknown slash command → 'did you mean' suggestion lookup",
    run: () => closest("/hlpe", COMMANDS),
  },
  {
    name: "fuzzy:edit-distance",
    why: "core of slash-command and @path fuzzy matching",
    run: () => editDistance("recursive-self-improvement", "recursive-elf-improvment"),
  },
  {
    name: "config:load",
    why: "every startup — settings.json + project profile resolve + schema parse",
    run: () => loadConfig({ flags: {} }),
  },
];
