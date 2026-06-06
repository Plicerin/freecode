// Regression for the OAuth "missing client_id" / "missing_required_parameter"
// bug: on Windows we must NOT open the URL via `cmd /c start`, because cmd treats
// '&' as a command separator and truncates the OAuth URL at the first '&',
// dropping client_id and every later param. The browser must receive the URL
// whole.
import { test, expect, describe } from "bun:test";
import { browserOpenCommand } from "../src/auth/callback-server";

const url = "https://claude.ai/oauth/authorize?code=true&client_id=ABC&scope=x%20y&state=S";

describe("browserOpenCommand", () => {
  test("Windows does not route through cmd and passes the full URL as one arg", () => {
    const { cmd, args } = browserOpenCommand("win32", url);
    expect(cmd).not.toMatch(/cmd/i);
    expect(cmd).toBe("rundll32.exe");
    expect(args).toContain(url); // the WHOLE url, '&' and all — never truncated
    expect(args.some((a) => a.includes("client_id=ABC"))).toBe(true);
  });

  test("macOS uses open, Linux uses xdg-open, each with the full URL", () => {
    expect(browserOpenCommand("darwin", url)).toEqual({ cmd: "open", args: [url] });
    expect(browserOpenCommand("linux", url)).toEqual({ cmd: "xdg-open", args: [url] });
  });
});
