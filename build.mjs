// Build a Node-runnable dist/cli.js so freecode installs from GitHub with npm and
// runs on plain Node — no Bun on the target machine. Uses esbuild (a Node-native
// bundler) so this same build runs as the npm `prepare` step on install. Our own
// source is bundled into one file; node_modules deps stay external (npm installs
// them). The version (package.json + git short SHA when a .git is present) is
// baked in via __FREECODE_VERSION__, matching the bun --compile path.
import { build } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
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
  outfile: join(root, "dist/cli.js"),
  banner: { js: "#!/usr/bin/env node" },
  // Ship the PRODUCTION React build. React's DEV build (NODE_ENV !== "production")
  // emits performance-track measures (`performance.measure`) on EVERY commit that
  // Node's performance timeline never frees — a long TUI session leaks to GBs and
  // OOMs. Compiling production here dead-code-eliminates that path (and it's the
  // norm for a shipped app). Also flips the app's own `=== "test"` checks to
  // false, which is correct for the shipped binary.
  define: {
    __FREECODE_VERSION__: JSON.stringify(version),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  logLevel: "warning",
});

console.log(`built dist/cli.js  (version ${version})`);
