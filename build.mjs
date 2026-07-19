// Build a Node-runnable dist/ so freecode installs from npm/GitHub and runs on
// plain Node — no Bun on the target. esbuild bundles our source into dist/main.js
// (node_modules deps stay external — npm installs them). The version (package.json
// + git short SHA when a .git is present) is baked in via __FREECODE_VERSION__.
//
// dist/cli.js is a tiny bin SHIM that sets NODE_ENV=production and THEN imports
// main.js. This is load-bearing: React is external (resolved at runtime), so it
// picks dev vs production from process.env.NODE_ENV when it evaluates — and its
// DEV build leaks (a `performance.measure` per commit that Node never frees → GBs
// over a long TUI session). The shim is the only place guaranteed to run before
// React evaluates, because it imports nothing of its own; it hands off to main.js
// (whose React import then sees NODE_ENV=production) via a dynamic import. Setting
// NODE_ENV inside main.js instead would be too late — its static React import is
// hoisted and evaluates first.
import { build } from "esbuild";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let version = pkg.version;
try {
  if (existsSync(join(root, ".git"))) {
    const sha = execSync("git rev-parse --short=7 HEAD", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (sha) version = `${pkg.version}+${sha}`;
  }
} catch {
  // no git (e.g. an npm-installed copy) — fall back to the bare package version
}

await build({
  entryPoints: [join(root, "src/cli.tsx")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external", // ink/react/etc. resolve from node_modules at runtime
  outfile: join(root, "dist/main.js"),
  // Only the version is a compile-time constant. NODE_ENV is NOT defined here —
  // it must stay a real runtime value so the shim can set it and external React
  // reads it. (Defining it would dead-code-eliminate the shim's assignment.)
  define: { __FREECODE_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});

const shim = `#!/usr/bin/env node
// Force React's production build before anything imports React (see build.mjs).
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
// Handle a LOAD/eval failure of the bundle (e.g. a missing/mismatched react|ink
// dependency) deterministically — a clean message + exit 1 instead of an ugly
// UnhandledPromiseRejection. Errors inside main() are handled there via .catch.
import("./main.js").catch((err) => { console.error(err && err.stack || err); process.exit(1); });
`;
writeFileSync(join(root, "dist/cli.js"), shim);

console.log(`built dist/cli.js + dist/main.js  (version ${version})`);
