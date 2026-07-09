// The committed .ps1 installers must parse on Windows PowerShell 5.1 — the
// DEFAULT shell on Windows — not just pwsh 7. A PS7-only ternary (? :) once
// shipped and 5.1 rejected it at parse time ("Unexpected token '?'"). This
// guards that class of regression by parsing each script with the real 5.1
// parser. Skipped off Windows (5.1 isn't there) and if powershell.exe is absent.
import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const onWindows = process.platform === "win32";

async function parseErrorsOn51(file: string): Promise<string | null> {
  const script =
    `$e=$null;$t=$null;` +
    `[System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e)|Out-Null;` +
    `if($e){[Console]::Error.Write($e[0].Message);exit 1}`;
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], { stderr: "pipe", stdout: "pipe" });
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return code === 0 ? null : err.trim() || "parse failed";
  } catch {
    return "SKIP"; // powershell.exe not available
  }
}

describe("installers parse on Windows PowerShell 5.1", () => {
  for (const f of ["install.ps1", "setup.ps1"]) {
    test.skipIf(!onWindows)(`${f} has no PS7-only syntax`, async () => {
      const path = join(import.meta.dir, "..", f);
      if (!existsSync(path)) return;
      const err = await parseErrorsOn51(path);
      if (err === "SKIP") return; // no 5.1 on this box
      expect(err).toBeNull();
    });
  }
});
