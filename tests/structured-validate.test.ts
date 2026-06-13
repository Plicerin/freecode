// A primary agent corrupted a package.json (duplicated script block → invalid JSON),
// freecode wrote it without noticing, the build broke, and the model blamed "the
// environment". This guard refuses a write that would leave a JSON-family file
// unparseable — catching the corruption at the source with a precise message.
import { test, expect, describe } from "bun:test";
import { structuredWriteError } from "../src/tools/structured-validate";

describe("structuredWriteError", () => {
  test("rejects the real corruption: a duplicated block missing its comma", () => {
    const corrupt = `{
  "scripts": {
    "build": "vite build"
  }
  "tauri:build": "tauri build"
}`;
    const err = structuredWriteError("package.json", corrupt);
    expect(err).not.toBeNull();
    expect(err).toContain("INVALID JSON");
    expect(err).toContain("package.json");
    expect(err).toMatch(/line \d+/);          // points at where it broke
  });

  test("allows valid JSON", () => {
    expect(structuredWriteError("package.json", `{ "name": "x", "scripts": { "build": "vite build" } }`)).toBeNull();
  });

  test("allows JSONC (comments + trailing comma) — tsconfig/settings not false-flagged", () => {
    const tsconfig = `{
  // compiler options
  "compilerOptions": { "strict": true },
}`;
    expect(structuredWriteError("tsconfig.json", tsconfig)).toBeNull();
  });

  test("ignores non-JSON files entirely", () => {
    expect(structuredWriteError("src/index.ts", "this is { not ] json")).toBeNull();
    expect(structuredWriteError("README.md", "{ broken")).toBeNull();
  });

  test("an empty write is allowed (truncation is a legitimate intent)", () => {
    expect(structuredWriteError("data.json", "")).toBeNull();
    expect(structuredWriteError("data.json", "   \n ")).toBeNull();
  });

  test("catches an unbalanced brace and a stray trailing token", () => {
    expect(structuredWriteError("a.json", `{ "a": 1 `)).not.toBeNull();
    expect(structuredWriteError("a.json", `{ "a": 1 } garbage`)).not.toBeNull();
  });

  test("covers the JSON family (json5 / webmanifest)", () => {
    expect(structuredWriteError("app.webmanifest", `{ "name": }`)).not.toBeNull();
  });
});
