// OpenAI-specific "Sign in with ChatGPT" config + the post-login token exchange.
//
// Values verified against openai/codex (codex-rs/login): issuer auth.openai.com,
// S256 PKCE, redirect http://localhost:1455/auth/callback, the scope set, the
// id_token_add_organizations / codex_cli_simplified_flow / originator params, and
// the RFC 8693 token-exchange that mints a real `openai-api-key` from the id_token
// — which is why freecode's EXISTING OpenAI provider can then use it against /v1,
// with no separate backend.
//
// The one value the login crate never hardcodes is the client_id (it's passed in
// by the codex app). We default to codex's well-known public client and let an
// env var override it, so if OpenAI ever rotates it the user has a one-line fix
// rather than a dead flow.
import { getEnv } from "../utils/env";
import type { OAuthConfig, TokenSet } from "./oauth";

const ISSUER = "https://auth.openai.com";

/** Default redirect port (codex uses 1455). Overridable for the rare conflict. */
export function oauthPort(): number {
  const raw = getEnv("FREECODE_OPENAI_OAUTH_PORT");
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 1455;
}

export function openAiOAuthConfig(): OAuthConfig {
  const clientId = getEnv("FREECODE_OPENAI_OAUTH_CLIENT_ID") || "app_EMoamEEZ73f0CkXaXp7hrann";
  return {
    authorizeUrl: `${ISSUER}/oauth/authorize`,
    tokenUrl: `${ISSUER}/oauth/token`,
    clientId,
    redirectUri: `http://localhost:${oauthPort()}/auth/callback`,
    // Must match codex's registered scope set exactly — omitting the connectors
    // scopes makes auth.openai.com reject the request (missing_required_parameter).
    scopes: ["openid", "profile", "email", "offline_access", "api.connectors.read", "api.connectors.invoke"],
    extraAuthParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
  };
}

/** Decode a JWT's payload (middle segment) without verifying the signature —
 *  we only read non-secret claims (the account id) the issuer already gave us. */
export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) return {};
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The ChatGPT account id, from the id_token's `chatgpt_account_id` claim
 *  (Codex nests it under auth claims; check both shapes). */
export function accountIdFromIdToken(idToken: string): string | undefined {
  const claims = decodeJwtClaims(idToken);
  const direct = claims["chatgpt_account_id"];
  if (typeof direct === "string") return direct;
  const auth = claims["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const nested = (auth as Record<string, unknown>)["chatgpt_account_id"];
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

export interface ExchangedKey {
  apiKey: string;
  accountId?: string;
}

/** RFC 8693 token exchange: id_token → a usable OpenAI API key. This is the step
 *  that makes the standard provider work; the first-leg access_token does not. */
export async function exchangeForApiKey(cfg: OAuthConfig, idToken: string): Promise<ExchangedKey> {
  const resp = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: cfg.clientId,
      requested_token: "openai-api-key",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    }).toString(),
  });
  const text = await resp.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* leave empty */ }
  if (!resp.ok) {
    const msg = (json.error_description as string) || (json.error as string) || `${resp.status} ${text.slice(0, 200)}`;
    throw new Error(`API-key token exchange failed: ${msg}`);
  }
  const apiKey = String(json.access_token ?? json.api_key ?? "");
  if (!apiKey) throw new Error("token exchange returned no API key");
  return { apiKey, accountId: accountIdFromIdToken(idToken) };
}

/** Convenience: the full token set plus the exchanged API key after login. */
export interface OpenAiLoginResult {
  tokens: TokenSet;
  apiKey: string;
  accountId?: string;
}
