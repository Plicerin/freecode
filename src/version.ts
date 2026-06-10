// Single source of the version string shown by `freecode --version`.
//
// For a COMPILED build, scripts/build-exe.ts injects the real version
// (package.json version + git short SHA, e.g. "0.1.0+a1b2c3d") via Bun's
// `--define:__FREECODE_VERSION__=...`. When running from source
// (`bun run src/cli.tsx`) the define is absent, so we fall back to a "-dev"
// marker. `typeof` on an undeclared identifier is safe (never throws), so this
// works in both modes without a try/catch.
declare const __FREECODE_VERSION__: string | undefined;

export const VERSION: string =
  typeof __FREECODE_VERSION__ !== "undefined" && __FREECODE_VERSION__
    ? __FREECODE_VERSION__
    : "0.1.0-dev";
