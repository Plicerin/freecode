// cli.tsx defaults NODE_ENV=production at runtime so a source run can't silently
// use DEV React (whose per-commit performance-track measures leak until the engine
// dies — the mazinger JSC MemoryExhaustion crash). That is only SAFE while the JSX
// transpile stays CLASSIC: React.createElement exists in both dev and production
// React, so flipping NODE_ENV after transpile is harmless. Under the AUTOMATIC
// runtime it would not be: Bun picks jsx vs jsxDEV from NODE_ENV at startup, so a
// late flip leaves jsxDEV calls hitting a production React ("jsxDEV is not a
// function"). This test locks that precondition — if someone switches tsconfig to
// "react-jsx", this fails loudly instead of shipping a crash.
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const root = join(import.meta.dir, "..");

describe("JSX transpile must stay CLASSIC", () => {
  test('tsconfig declares "jsx": "react" (classic)', () => {
    const tsconfig = readFileSync(join(root, "tsconfig.json"), "utf8");
    expect(tsconfig).toMatch(/"jsx"\s*:\s*"react"/);
    expect(tsconfig).not.toMatch(/"jsx"\s*:\s*"react-jsx(dev)?"/);
  });

  test("Bun emits React.createElement and never jsxDEV", async () => {
    const built = await Bun.build({
      entrypoints: [join(root, "src", "tui", "mascot.tsx")],
      target: "bun",
      external: ["*"],
    });
    expect(built.success).toBe(true);
    const code = await built.outputs[0]!.text();
    expect(code).toContain("createElement");
    expect(code).not.toContain("jsxDEV");
  });
});
