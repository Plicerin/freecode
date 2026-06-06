// OAuth + PKCE core (for "Sign in with ChatGPT" and any future OAuth provider).
// The security-critical pieces are pure, so we pin them hard — including the
// RFC 7636 Appendix B test vector, so a regression in the challenge derivation
// can't slip through.
import { test, expect, describe } from "bun:test";
import { base64url, challengeFromVerifier, generateVerifier, randomState, createPkce } from "../src/auth/pkce";
import { buildAuthUrl, parseTokenResponse, isExpired, type OAuthConfig } from "../src/auth/oauth";

describe("PKCE", () => {
  test("matches the RFC 7636 Appendix B S256 vector", () => {
    // verifier and expected challenge straight from the RFC.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(challengeFromVerifier(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("base64url has no +, /, or = padding", () => {
    const s = base64url(Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]));
    expect(s).not.toMatch(/[+/=]/);
  });

  test("generated verifiers are within the RFC length bounds and unique", () => {
    const a = generateVerifier();
    const b = generateVerifier();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(randomState()).not.toBe(randomState());
  });

  test("createPkce yields a verifier whose S256 challenge it carries", () => {
    const p = createPkce();
    expect(p.method).toBe("S256");
    expect(p.challenge).toBe(challengeFromVerifier(p.verifier));
  });
});

const cfg: OAuthConfig = {
  authorizeUrl: "https://auth.example.com/oauth/authorize",
  tokenUrl: "https://auth.example.com/oauth/token",
  clientId: "client-123",
  redirectUri: "http://localhost:1455/callback",
  scopes: ["openid", "profile", "offline_access"],
};

describe("authorize URL", () => {
  test("carries PKCE challenge, S256 method, state, and properly-encoded params", () => {
    const url = new URL(buildAuthUrl(cfg, { challenge: "CHAL", state: "STATE" }));
    expect(url.origin + url.pathname).toBe("https://auth.example.com/oauth/authorize");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("client-123");
    expect(p.get("redirect_uri")).toBe("http://localhost:1455/callback");
    expect(p.get("scope")).toBe("openid profile offline_access");
    expect(p.get("code_challenge")).toBe("CHAL");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("STATE");
  });

  test("merges provider-specific extra params", () => {
    const url = new URL(buildAuthUrl({ ...cfg, extraAuthParams: { prompt: "login", id_token_add_organizations: "true" } }, { challenge: "C", state: "S" }));
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
  });
});

describe("token response handling", () => {
  test("parses expires_in into an absolute expiry and carries the refresh token", () => {
    const t = parseTokenResponse({ access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer" }, 1_000_000);
    expect(t.accessToken).toBe("AT");
    expect(t.refreshToken).toBe("RT");
    expect(t.expiresAt).toBe(1_000_000 + 3600_000);
  });

  test("isExpired respects the skew window", () => {
    const t = parseTokenResponse({ access_token: "AT", expires_in: 100 }, 0); // expiresAt = 100_000, skew threshold = 40_000
    expect(isExpired(t, 0)).toBe(false); // plenty of time left
    expect(isExpired(t, 30_000)).toBe(false); // still before the skew window
    expect(isExpired(t, 40_000)).toBe(true); // exactly at the 60s-before-expiry skew
    expect(isExpired(t, 100_000)).toBe(true); // past expiry
    const noExpiry = parseTokenResponse({ access_token: "AT" }, 0);
    expect(isExpired(noExpiry, Date.now())).toBe(false); // no expiry → never forced
  });
});
