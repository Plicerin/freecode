// Anthropic "Sign in with Claude" (Pro/Max subscription) OAuth.
//
// Values verified against multiple independent open-source implementations
// (client_id appears verbatim in ~17 repos; flow + endpoints from ghuntley/loom's
// claude-subscription-auth spec): authorize at claude.ai, token at
// console.anthropic.com, a HOSTED redirect (console.anthropic.com/oauth/code/
// callback) that displays a `code#state` for the user to paste back — so there's
// NO localhost callback server, unlike the OpenAI flow.
//
// Unlike OpenAI (which mints a normal API key), the Pro/Max subscription is used
// by sending the access_token as `Authorization: Bearer` + an `anthropic-beta`
// header, with x-api-key ABSENT. That's why the Anthropic provider needs an OAuth
// mode (see anthropic.ts). client_id is env-overridable for resilience.
import { getEnv } from "../utils/env";
import type { TokenSet } from "./oauth";

const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"; // Pro/Max subscription
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = ["org:create_api_key", "user:profile", "user:inference"];

/** Beta flags required when authenticating with an OAuth (subscription) token.
 *  `oauth-2025-04-20` is the load-bearing one; the rest enable Claude Code feats. */
export const ANTHROPIC_OAUTH_BETAS = [
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
].join(",");

export function anthropicClientId(): string {
  return getEnv("FREECODE_ANTHROPIC_OAUTH_CLIENT_ID") || DEFAULT_CLIENT_ID;
}

/** Build the claude.ai authorize URL. Percent-encode (space → %20) — never the
 *  URLSearchParams "+", which auth servers reject in `scope` (see oauth.ts). */
export function buildAnthropicAuthUrl(opts: { challenge: string; state: string }): string {
  const pairs: Array<[string, string]> = [
    ["code", "true"],
    ["client_id", anthropicClientId()],
    ["response_type", "code"],
    ["redirect_uri", REDIRECT_URI],
    ["scope", SCOPES.join(" ")],
    ["code_challenge", opts.challenge],
    ["code_challenge_method", "S256"],
    ["state", opts.state],
  ];
  return `${AUTHORIZE_URL}?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

/** The hosted callback shows the user a `code#state` string; split it. Pure. */
export function parsePastedCode(input: string): { code: string; state: string } {
  const trimmed = input.trim();
  const hash = trimmed.indexOf("#");
  if (hash === -1) return { code: trimmed, state: "" };
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
}

// Anthropic's token endpoint takes a JSON body (not form-urlencoded) and the
// auth-code exchange includes `state` alongside the code.
async function postJson(body: Record<string, string>): Promise<TokenSet> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* empty */ }
  if (!resp.ok) {
    const msg = (json.error_description as string) || (json.error as string) || `${resp.status} ${text.slice(0, 200)}`;
    throw new Error(`Anthropic token request failed: ${msg}`);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  return {
    accessToken: String(json.access_token ?? ""),
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    tokenType: json.token_type ? String(json.token_type) : undefined,
    scope: json.scope ? String(json.scope) : undefined,
  };
}

export async function exchangeAnthropicCode(code: string, state: string, verifier: string): Promise<TokenSet> {
  const tokens = await postJson({
    grant_type: "authorization_code",
    code,
    state,
    client_id: anthropicClientId(),
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  if (!tokens.accessToken) throw new Error("token exchange returned no access_token");
  return tokens;
}

export async function refreshAnthropicTokens(refreshToken: string): Promise<TokenSet> {
  const next = await postJson({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: anthropicClientId(),
  });
  if (!next.refreshToken) next.refreshToken = refreshToken;
  return next;
}
