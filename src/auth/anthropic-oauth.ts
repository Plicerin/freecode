// Anthropic "Sign in with Claude" (Pro/Max subscription) OAuth.
//
// STATUS: EXPERIMENTAL / currently NOT WORKING. As of 2026-06, Anthropic is
// migrating OAuth from console.anthropic.com → platform.claude.com, and the
// claude.ai authorize endpoint rejects the request ("invalid request format")
// even when matched byte-for-byte to the maintained `anthropic-auth` crate. The
// reverse-engineered Claude Code source, vibekit, and that crate all disagree and
// are all stale against the live migration. The infra below (PKCE, exchange,
// provider OAuth mode) is sound and unit-tested; the params are best-effort and
// will need updating once the migration settles. For a reliable Anthropic setup,
// use an API key: `freecode auth set anthropic`.
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

// Values taken verbatim from the actual Claude Code OAuth config (not a
// third-party port — those diverge and were wrong). Notably: the authorize host
// is console.anthropic.com (NOT claude.ai), there is NO `code=true` param, the
// scope set is exactly these two, and the manual-flow redirect_uri is the
// RELATIVE "/oauth/code/callback".
// Matched byte-for-byte to the maintained `anthropic-auth` crate (querymt), the
// reference the user pointed to: Max authorize on claude.ai, `code=true` present,
// ABSOLUTE redirect to console.anthropic.com/oauth/code/callback, three scopes,
// form-encoded ('+'). (The reverse-engineered Claude Code source differed — it's
// likely an older build; the sources genuinely conflict as Anthropic migrates.)
const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
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

/** Build the claude.ai authorize URL. NOTE: unlike OpenAI (which needs %20),
 *  Anthropic's mint step wants form-encoding — spaces as "+" — so we build with
 *  URLSearchParams, matching current working implementations (e.g. vibekit). The
 *  consent page renders either way, but clicking "Authorize" fails with "invalid
 *  request format" if scope spaces are %20. Param order mirrors vibekit. */
export function buildAnthropicAuthUrl(opts: { challenge: string; state: string }): string {
  // Param set + order match the anthropic-auth crate's start_flow(Max) exactly.
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", anthropicClientId());
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", REDIRECT_URI);
  url.searchParams.append("scope", SCOPES.join(" "));
  url.searchParams.append("code_challenge", opts.challenge);
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", opts.state);
  return url.toString();
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
    // Working impls (vibekit) send the OAuth beta header on the token request too.
    headers: { "content-type": "application/json", accept: "application/json", "anthropic-beta": ANTHROPIC_OAUTH_BETAS },
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
