// OpenAI "Sign in with ChatGPT" — the pure pieces. The live browser/token flow
// can't run in CI, so we pin everything that's deterministic: the config matches
// the values verified against openai/codex, the authorize URL carries the
// codex-specific params, id_token claim decoding finds the account id, and the
// localhost callback parser enforces the state (CSRF) check.
import { test, expect, describe, afterEach } from "bun:test";
import { openAiOAuthConfig, decodeJwtClaims, accountIdFromIdToken } from "../src/auth/openai-oauth";
import { buildAuthUrl } from "../src/auth/oauth";
import { parseCallbackQuery } from "../src/auth/callback-server";

// base64url-encode a JSON object the way a JWT segment is encoded.
function seg(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fakeJwt(claims: Record<string, unknown>): string {
  return `${seg({ alg: "none" })}.${seg(claims)}.`;
}

afterEach(() => {
  delete process.env.FREECODE_OPENAI_OAUTH_CLIENT_ID;
  delete process.env.FREECODE_OPENAI_OAUTH_PORT;
});

describe("openAiOAuthConfig", () => {
  test("uses the verified OpenAI endpoints, redirect, and scopes", () => {
    const cfg = openAiOAuthConfig();
    expect(cfg.authorizeUrl).toBe("https://auth.openai.com/oauth/authorize");
    expect(cfg.tokenUrl).toBe("https://auth.openai.com/oauth/token");
    expect(cfg.redirectUri).toBe("http://localhost:1455/auth/callback");
    expect(cfg.scopes).toContain("offline_access");
    expect(cfg.extraAuthParams?.id_token_add_organizations).toBe("true");
    expect(cfg.extraAuthParams?.codex_cli_simplified_flow).toBe("true");
    expect(cfg.extraAuthParams?.originator).toBe("codex_cli_rs");
  });

  test("client_id and port are env-overridable (so a rotated id is a one-line fix)", () => {
    process.env.FREECODE_OPENAI_OAUTH_CLIENT_ID = "app_custom";
    process.env.FREECODE_OPENAI_OAUTH_PORT = "1460";
    const cfg = openAiOAuthConfig();
    expect(cfg.clientId).toBe("app_custom");
    expect(cfg.redirectUri).toBe("http://localhost:1460/auth/callback");
  });

  test("the built authorize URL carries PKCE + the codex params", () => {
    const cfg = openAiOAuthConfig();
    const u = new URL(buildAuthUrl(cfg, { challenge: "CH", state: "ST" }));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe("CH");
    expect(u.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(u.searchParams.get("scope")).toContain("offline_access");
  });
});

describe("id_token claims", () => {
  test("reads chatgpt_account_id from a top-level claim", () => {
    expect(accountIdFromIdToken(fakeJwt({ chatgpt_account_id: "acc_top" }))).toBe("acc_top");
  });

  test("reads it from the nested OpenAI auth claim too", () => {
    const jwt = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_nested" } });
    expect(accountIdFromIdToken(jwt)).toBe("acc_nested");
  });

  test("decodeJwtClaims tolerates garbage without throwing", () => {
    expect(decodeJwtClaims("not.a.jwt")).toEqual({});
    expect(accountIdFromIdToken("garbage")).toBeUndefined();
  });
});

describe("callback parsing (CSRF state check)", () => {
  test("accepts a matching state and returns the code", () => {
    expect(parseCallbackQuery("/auth/callback?code=abc&state=ST", "ST")).toEqual({ code: "abc" });
  });

  test("rejects a state mismatch", () => {
    expect(parseCallbackQuery("/auth/callback?code=abc&state=EVIL", "ST").error).toMatch(/state mismatch/);
  });

  test("surfaces an OAuth error param", () => {
    expect(parseCallbackQuery("/auth/callback?error=access_denied&error_description=nope&state=ST", "ST").error).toBe("nope");
  });

  test("rejects a missing code", () => {
    expect(parseCallbackQuery("/auth/callback?state=ST", "ST").error).toMatch(/no authorization code/);
  });
});
