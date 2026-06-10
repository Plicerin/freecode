// When a foreground command times out, the Bash tool's advice must depend on
// WHAT timed out: a dev server never exits, so "pass a larger timeoutMs" is wrong
// — the fix is runInBackground:true. This guards the detection that drives that
// message (the model in production ran `npm run dev`/vite foreground, hit the
// timeout, and wrongly told the user the server "can't start").
import { test, expect, describe } from "bun:test";
import { looksLikeLongRunningServer } from "../src/tools/bash";

describe("looksLikeLongRunningServer", () => {
  test("dev servers / watchers are detected", () => {
    for (const cmd of [
      "vite",
      "npm run dev",
      "npm run dev -- --port 5180",
      "pnpm dev",
      "yarn start",
      "bun run dev",
      "next dev",
      "astro dev",
      "ng serve",
      "python -m http.server 8000",
      "php -S localhost:8000",
      "uvicorn app:main --reload",
      "npm run watch",
    ]) {
      expect(looksLikeLongRunningServer(cmd)).toBe(true);
    }
  });

  test("ordinary one-shot commands are NOT flagged", () => {
    for (const cmd of [
      "npm run build",
      "npm test",
      "tsc --noEmit",
      "git status",
      "ls -la",
      "npm install",
      "node script.js",
    ]) {
      expect(looksLikeLongRunningServer(cmd)).toBe(false);
    }
  });
});
