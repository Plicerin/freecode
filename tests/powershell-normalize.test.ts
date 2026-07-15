// Weak models emit bash redirects like `2>/dev/null`; PowerShell treats /dev/null
// as a file path (C:\dev\null) and errors. In one real session 5 of 10 Bash calls
// failed this exact way. normalizeForPowerShell rewrites the unambiguous bash-isms
// to PowerShell so those commands just work; valid PowerShell is left untouched.
import { test, expect, describe } from "bun:test";
import { normalizeForPowerShell } from "../src/tools/bash";

describe("normalizeForPowerShell", () => {
  test("2>/dev/null -> 2>$null (the dominant real failure)", () => {
    expect(normalizeForPowerShell("Get-ChildItem foo 2>/dev/null")).toBe("Get-ChildItem foo 2>$null");
  });
  test("stdout redirects: >/dev/null and 1>/dev/null", () => {
    expect(normalizeForPowerShell("cmd >/dev/null")).toBe("cmd >$null");
    expect(normalizeForPowerShell("cmd 1>/dev/null")).toBe("cmd 1>$null");
  });
  test("tolerates a space after the redirect operator", () => {
    expect(normalizeForPowerShell("cmd 2> /dev/null")).toBe("cmd 2>$null");
  });
  test("&>/dev/null (both streams) -> *>$null", () => {
    expect(normalizeForPowerShell("cmd &>/dev/null")).toBe("cmd *>$null");
  });
  test("combined `> /dev/null 2>&1` keeps the stream-merge", () => {
    expect(normalizeForPowerShell("build > /dev/null 2>&1")).toBe("build >$null 2>&1");
  });
  test("a bare /dev/null argument becomes $null", () => {
    expect(normalizeForPowerShell("Copy-Item x /dev/null")).toBe("Copy-Item x $null");
  });
  test("leaves valid PowerShell (and 2>&1, 2>$null) untouched", () => {
    for (const c of ["Get-ChildItem C:\\ -Recurse", "git status 2>&1", "cmd 2>$null", "npm test", "echo hi | Out-String"]) {
      expect(normalizeForPowerShell(c)).toBe(c);
    }
  });
});
