// Translating Unix commands → PowerShell so a weak/local model's muscle memory
// (grep/head/tail/which/ls) works on Windows instead of erroring and looping.
// The core risk is a WRONG rewrite, so these lock the faithful mappings AND the
// passthrough (leave-unchanged) behavior for anything unmappable.
import { test, expect, describe } from "bun:test";
import { translateUnixCommand } from "../src/tools/win-cmd-translate";

const tr = translateUnixCommand;

describe("grep → Select-String", () => {
  test("basic grep is case-SENSITIVE (grep default) with -Path", () => {
    expect(tr("grep foo file.txt")).toBe("Select-String -Pattern 'foo' -CaseSensitive -Path file.txt");
  });
  test("-i drops -CaseSensitive (Select-String is case-insensitive by default)", () => {
    expect(tr("grep -i foo file.txt")).toBe("Select-String -Pattern 'foo' -Path file.txt");
  });
  test("-r recurses via Get-ChildItem", () => {
    expect(tr("grep -r TODO src")).toBe("Get-ChildItem -Recurse -File src | Select-String -Pattern 'TODO' -CaseSensitive");
  });
  test("-rn combined, default path '.'", () => {
    expect(tr("grep -rn pattern")).toBe("Get-ChildItem -Recurse -File . | Select-String -Pattern 'pattern' -CaseSensitive");
  });
  test("-v invert, -w word-boundary", () => {
    expect(tr("grep -vw foo f")).toBe("Select-String -Pattern '\\bfoo\\b' -CaseSensitive -NotMatch -Path f");
  });
  test("-F fixed strings → -SimpleMatch", () => {
    expect(tr("grep -F 'a.b*c' f")).toBe("Select-String -Pattern 'a.b*c' -SimpleMatch -CaseSensitive -Path f");
  });
  test("-l files-with-matches", () => {
    expect(tr("grep -rl needle src")).toBe("Get-ChildItem -Recurse -File src | Select-String -Pattern 'needle' -CaseSensitive | Select-Object -ExpandProperty Path -Unique");
  });
  test("in a pipe, grep reads stdin (no -Path)", () => {
    expect(tr("cat foo | grep bar")).toBe("cat foo | Select-String -Pattern 'bar' -CaseSensitive");
  });
  test("multiple paths become a comma array", () => {
    expect(tr("grep foo a.ts b.ts")).toBe("Select-String -Pattern 'foo' -CaseSensitive -Path a.ts,b.ts");
  });
  test("single-quotes in the pattern are escaped, redirection preserved", () => {
    expect(tr("grep -i \"it's\" f 2>/dev/null")).toBe("Select-String -Pattern 'it''s' -Path f 2>/dev/null");
  });
  test("egrep/fgrep map to -E/-F", () => {
    expect(tr("egrep foo f")).toBe("Select-String -Pattern 'foo' -CaseSensitive -Path f");
    expect(tr("fgrep a.b f")).toBe("Select-String -Pattern 'a.b' -SimpleMatch -CaseSensitive -Path f");
  });

  test("unmappable flags pass through UNCHANGED (wrong output would be worse)", () => {
    for (const cmd of ["grep -c foo f", "grep -o foo f", "grep -A2 foo f", "grep --perl-regexp foo f"]) {
      expect(tr(cmd)).toBe(cmd);
    }
  });
  test("grep with neither a file nor a pipe passes through (would read stdin)", () => {
    expect(tr("grep foo")).toBe("grep foo");
  });
});

describe("head / tail", () => {
  test("head file default 10", () => { expect(tr("head file")).toBe("Get-Content file -TotalCount 10"); });
  test("head -n N", () => { expect(tr("head -n 5 file")).toBe("Get-Content file -TotalCount 5"); });
  test("head -N shorthand", () => { expect(tr("head -20 file")).toBe("Get-Content file -TotalCount 20"); });
  test("tail -n N", () => { expect(tr("tail -n 3 log.txt")).toBe("Get-Content log.txt -Tail 3"); });
  test("head in a pipe → Select-Object -First", () => { expect(tr("ls | head -5")).toBe("Get-ChildItem | Select-Object -First 5"); });
  test("tail in a pipe → Select-Object -Last", () => { expect(tr("cat f | tail -n 2")).toBe("cat f | Select-Object -Last 2"); });
  test("tail -f passes through (follow blocks)", () => { expect(tr("tail -f log")).toBe("tail -f log"); });
});

describe("which / ls", () => {
  test("which resolves the path", () => {
    expect(tr("which node")).toBe("Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source");
  });
  test("ls -la → Get-ChildItem -Force", () => { expect(tr("ls -la")).toBe("Get-ChildItem -Force"); });
  test("ls -R path → -Recurse", () => { expect(tr("ls -R src")).toBe("Get-ChildItem -Recurse src"); });
  test("bare ls", () => { expect(tr("ls")).toBe("Get-ChildItem"); });
});

describe("safety / non-interference", () => {
  test("real PowerShell is left alone", () => {
    for (const cmd of ["Get-ChildItem -Recurse", "Select-String -Pattern 'x' -Path f", "npm run build", "git commit -m 'grep'"]) {
      expect(tr(cmd)).toBe(cmd);
    }
  });
  test("a 'grep' that is an ARGUMENT, not the command, is not touched", () => {
    expect(tr("echo grep foo")).toBe("echo grep foo");
    expect(tr("git commit -m \"add grep support\"")).toBe("git commit -m \"add grep support\"");
  });
  test("pipe-through-quotes does not mis-split", () => {
    expect(tr("grep 'a|b' file")).toBe("Select-String -Pattern 'a|b' -CaseSensitive -Path file");
  });
  test("&& chains translate each side", () => {
    expect(tr("head -2 a && grep x b")).toBe("Get-Content a -TotalCount 2 && Select-String -Pattern 'x' -CaseSensitive -Path b");
  });
  test("FREECODE_NO_CMD_TRANSLATE disables it", () => {
    const prev = process.env.FREECODE_NO_CMD_TRANSLATE;
    process.env.FREECODE_NO_CMD_TRANSLATE = "1";
    try { expect(tr("grep foo f")).toBe("grep foo f"); }
    finally { if (prev === undefined) delete process.env.FREECODE_NO_CMD_TRANSLATE; else process.env.FREECODE_NO_CMD_TRANSLATE = prev; }
  });
});
