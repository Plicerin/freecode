// Anthropic "Sign in with Claude" (Pro/Max) — pure pieces. The live flow can't
// run in CI; pin the deterministic bits: the authorize URL targets claude.ai with
// the codex-style params + %20 encoding, the client_id is env-overridable, and the
// pasted `code#state` parser splits correctly (the manual flow has no callback).
import { test, expect, describe, afterEach } from "bun:test";
import { buildAnthropicAuthUrl, parsePastedCode, anthropicClientId, ANTHROPIC_OAUTH_BETAS } from "../src/auth/anthropic-oauth";

afterEach(() => { delete process.env.FREECODE_ANTHROPIC_OAUTH_CLIENT_ID; });

describe("buildAnthropicAuthUrl", () => {
  test("targets claude.ai with the verified params and %20-encoded scope", () => {
    const raw = buildAnthropicAuthUrl({ challenge: "CH", state: "ST" });
    expect(raw.startsWith("https://claude.ai/oauth/authorize?")).toBe(true);
    const u = new URL(raw);
    expect(u.searchParams.get("code")).toBe("true");
    expect(u.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe("https://console.anthropic.com/oauth/code/callback");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe("CH");
    expect(u.searchParams.get("state")).toBe("ST");
    // scope spaces must be %20, never '+'
    expect(raw).toContain("scope=org%3Acreate_api_key%20user%3Aprofile%20user%3Ainference");
    expect(raw).not.toMatch(/scope=[^&]*\+/);
  });

  test("client_id is env-overridable", () => {
    process.env.FREECODE_ANTHROPIC_OAUTH_CLIENT_ID = "custom-client";
    expect(anthropicClientId()).toBe("custom-client");
    expect(new URL(buildAnthropicAuthUrl({ challenge: "C", state: "S" })).searchParams.get("client_id")).toBe("custom-client");
  });
});

describe("parsePastedCode", () => {
  test("splits the hosted page's code#state", () => {
    expect(parsePastedCode("THE_CODE#THE_STATE")).toEqual({ code: "THE_CODE", state: "THE_STATE" });
  });
  test("tolerates a bare code (no #state)", () => {
    expect(parsePastedCode("  JUST_CODE  ")).toEqual({ code: "JUST_CODE", state: "" });
  });
});

describe("beta flags", () => {
  test("include the load-bearing oauth flag", () => {
    expect(ANTHROPIC_OAUTH_BETAS).toContain("oauth-2025-04-20");
  });
});
