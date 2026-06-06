// Generic OAuth 2.0 (authorization-code + PKCE) client. Provider-agnostic: the
// concrete endpoints/client_id live in a per-provider OAuthConfig, so OpenAI,
// Azure, or anything else plugs in by supplying one. The URL builder and token
// parsing are pure (testable); only the two fetch() calls touch the network.

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  /** Extra static params some providers require on the authorize URL. */
  extraAuthParams?: Record<string, string>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Absolute epoch ms when the access token expires (if the provider said so). */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

/** Build the authorize URL the user opens in a browser. Pure → unit-tested. */
export function buildAuthUrl(cfg: OAuthConfig, opts: { challenge: string; state: string }): string {
  const u = new URL(cfg.authorizeUrl);
  const p = u.searchParams;
  p.set("response_type", "code");
  p.set("client_id", cfg.clientId);
  p.set("redirect_uri", cfg.redirectUri);
  p.set("scope", cfg.scopes.join(" "));
  p.set("code_challenge", opts.challenge);
  p.set("code_challenge_method", "S256");
  p.set("state", opts.state);
  for (const [k, v] of Object.entries(cfg.extraAuthParams ?? {})) p.set(k, v);
  return u.toString();
}

/** Normalise a provider token-endpoint JSON response into our TokenSet. Pure. */
export function parseTokenResponse(json: Record<string, unknown>, now: number): TokenSet {
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  return {
    accessToken: String(json.access_token ?? ""),
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    idToken: json.id_token ? String(json.id_token) : undefined,
    expiresAt: expiresIn ? now + expiresIn * 1000 : undefined,
    tokenType: json.token_type ? String(json.token_type) : undefined,
    scope: json.scope ? String(json.scope) : undefined,
  };
}

/** A token is due for refresh if it expires within `skewMs` (default 60s). */
export function isExpired(tokens: TokenSet, now: number, skewMs = 60_000): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - skewMs <= now;
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await resp.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* leave empty */ }
  if (!resp.ok) {
    const msg = (json.error_description as string) || (json.error as string) || `${resp.status} ${text.slice(0, 200)}`;
    throw new Error(`OAuth token request failed: ${msg}`);
  }
  return json;
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export async function exchangeCode(cfg: OAuthConfig, opts: { code: string; verifier: string }, now = Date.now()): Promise<TokenSet> {
  const json = await postForm(cfg.tokenUrl, {
    grant_type: "authorization_code",
    code: opts.code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code_verifier: opts.verifier,
  });
  return parseTokenResponse(json, now);
}

/** Trade a refresh token for a fresh access token (keeps the refresh token if the
 *  provider doesn't rotate it). */
export async function refreshTokens(cfg: OAuthConfig, refreshToken: string, now = Date.now()): Promise<TokenSet> {
  const json = await postForm(cfg.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  const next = parseTokenResponse(json, now);
  if (!next.refreshToken) next.refreshToken = refreshToken;
  return next;
}
