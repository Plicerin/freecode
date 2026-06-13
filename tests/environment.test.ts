// Orient the agent with facts so a weak model can't be trapped by its directory.
// The marquee case: freecode launched in a WRAPPER folder (no package.json), so
// `npm run build` walked up to a stranger's Astro project and the agent flailed +
// blamed "the environment". These tests build that exact tree on disk and assert
// the orientation block names the real subfolder project and its scripts.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectEnvironment, environmentLines, detectPackageManager } from "../src/agent/environment";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "fc-env-"));
}
function writePkg(dir: string, pkg: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

describe("detectPackageManager", () => {
  test("reads the lockfile", () => {
    const d = tmp();
    writeFileSync(join(d, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(d)).toBe("pnpm");
    const b = tmp();
    writeFileSync(join(b, "bun.lock"), "");
    expect(detectPackageManager(b)).toBe("bun");
    expect(detectPackageManager(tmp())).toBeUndefined();
  });
});

describe("the wrapper-folder trap (the WinPort case)", () => {
  // <wrapper>/                         <- cwd, NO package.json
  //   WinPort-Monitor/package.json     <- the REAL project (vite + tauri)
  //     src-tauri/
  const wrapper = tmp();
  const project = join(wrapper, "WinPort-Monitor");
  writePkg(project, {
    name: "react-example",
    scripts: { dev: "vite", build: "vite build", "tauri:build": "tauri build" },
  });
  mkdirSync(join(project, "src-tauri"), { recursive: true });
  writeFileSync(join(project, "package-lock.json"), "");

  const env = detectEnvironment(wrapper);

  test("cwd is flagged as having no project; the child project is found", () => {
    expect(env.here).toBeNull();
    expect(env.children).toHaveLength(1);
    expect(env.children[0]!.name).toBe("react-example");
    expect(env.children[0]!.tauri).toBe(true);
    expect(env.children[0]!.packageManager).toBe("npm");
    expect(env.children[0]!.scripts).toContain("tauri:build");
  });

  test("the orientation block warns and names the subfolder + its real scripts", () => {
    const block = environmentLines(env, "Windows", "PowerShell").join("\n");
    expect(block).toContain("NO package.json in this directory");
    expect(block).toContain("./WinPort-Monitor");
    expect(block).toContain("react-example");
    expect(block).toContain("tauri:build");   // the script gemma never found
    expect(block).toContain("Tauri");
    // it must NOT claim this folder is the project root
    expect(block).not.toContain("This directory IS the project root");
  });
});

describe("cwd IS the project", () => {
  const dir = tmp();
  writePkg(dir, { name: "freecode", scripts: { test: "bun test", build: "bun build" } });
  writeFileSync(join(dir, "bun.lockb"), "");
  const env = detectEnvironment(dir);

  test("reports project root + manager + scripts, no warning", () => {
    expect(env.here?.name).toBe("freecode");
    const block = environmentLines(env, "Linux", "bash").join("\n");
    expect(block).toContain("This directory IS the project root");
    expect(block).toContain("bun");
    expect(block).toContain("scripts: test, build");
    expect(block).not.toContain("⚠");
  });
});

describe("no package.json here, one above (npm walk-up)", () => {
  const root = tmp();
  writePkg(root, { name: "outer-astro", scripts: { build: "astro build" } });
  const sub = join(root, "empty-subdir");
  mkdirSync(sub, { recursive: true });
  const env = detectEnvironment(sub);

  test("warns that npm run walks up to the ancestor project", () => {
    expect(env.here).toBeNull();
    expect(env.children).toHaveLength(0);
    expect(env.ancestor?.name).toBe("outer-astro");
    const block = environmentLines(env, "Linux", "bash").join("\n");
    expect(block).toContain("walking UP");
    expect(block).toContain("outer-astro");
  });
});
