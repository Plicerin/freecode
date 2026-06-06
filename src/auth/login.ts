// Orchestrates "Sign in with ChatGPT" end to end:
//   PKCE → open browser → catch the localhost redirect → exchange code for tokens
//   → RFC 8693 exchange the id_token for a real OpenAI API key → persist.
// The API key is stored under the normal `openai` vault slot, so the existing
// provider picks it up with zero further wiring; the OAuth tokens (for refresh)
// go under `oauth:openai`. `print` is injected so the flow is quiet in tests.
import { Vault } from "../config/vault";
import { createPkce, randomState } from "./pkce";
import { buildAuthUrl, exchangeCode, refreshTokens } from "./oauth";
import { openAiOAuthConfig, oauthPort, exchangeForApiKey } from "./openai-oauth";
import { waitForCallback, openBrowser } from "./callback-server";
import { saveTokens, loadTokens, clearTokens } from "./store";

export interface LoginOptions {
  print?: (line: string) => void;
  open?: (url: string) => void;
}

/** Run the full ChatGPT login and persist the result. Returns the account id. */
export async function loginOpenAI(opts: LoginOptions = {}): Promise<{ accountId?: string }> {
  const print = opts.print ?? ((l: string) => process.stdout.write(l + "\n"));
  const open = opts.open ?? openBrowser;
  const cfg = openAiOAuthConfig();
  const pkce = createPkce();
  const state = randomState();
  const url = buildAuthUrl(cfg, { challenge: pkce.challenge, state });

  print("Opening your browser to sign in with ChatGPT…");
  print(`If it doesn't open, paste this URL:\n  ${url}`);
  open(url);

  const code = await waitForCallback({ port: oauthPort(), expectedState: state });
  print("Got it — exchanging tokens…");
  const tokens = await exchangeCode(cfg, { code, verifier: pkce.verifier });
  if (!tokens.idToken) throw new Error("no id_token returned — cannot mint an API key");

  const exchanged = await exchangeForApiKey(cfg, tokens.idToken);

  // Persist: OAuth tokens for refresh, and the minted key under the standard slot.
  const vault = Vault.load();
  saveTokens("openai", tokens, vault);
  vault.set("openai", exchanged.apiKey);
  print("✓ Signed in with ChatGPT — OpenAI is ready (key stored in the vault).");
  return { accountId: exchanged.accountId };
}

/** Re-mint the API key from the stored refresh token (when the key has expired
 *  or been rejected). Throws if there's no refresh token — the user must log in. */
export async function refreshOpenAI(): Promise<void> {
  const vault = Vault.load();
  const cur = loadTokens("openai", vault);
  if (!cur?.refreshToken) throw new Error("not signed in with ChatGPT — run `freecode auth login`");
  const cfg = openAiOAuthConfig();
  const next = await refreshTokens(cfg, cur.refreshToken);
  if (!next.idToken) throw new Error("refresh returned no id_token — re-run `freecode auth login`");
  const exchanged = await exchangeForApiKey(cfg, next.idToken);
  saveTokens("openai", next, vault);
  vault.set("openai", exchanged.apiKey);
}

/** Drop the ChatGPT login. Leaves a manually-set API key alone unless it was the
 *  minted one (we can't always tell, so we only clear the oauth tokens here). */
export function logoutOpenAI(): void {
  clearTokens("openai");
}

// ── Anthropic "Sign in with Claude" (Pro/Max subscription) ──────────────────
// Manual code-paste flow: there's no localhost callback — claude.ai redirects to
// a hosted page that shows a `code#state` string the user pastes back. The
// access token is stored under oauth:anthropic and used by the provider in OAuth
// (Bearer) mode; no x-api-key is set, so the subscription is billed, not the API.
import { buildAnthropicAuthUrl, parsePastedCode, exchangeAnthropicCode, refreshAnthropicTokens } from "./anthropic-oauth";

export interface AnthropicLoginOptions {
  print?: (line: string) => void;
  open?: (url: string) => void;
  /** Read the pasted `code#state` from the user. */
  readCode: () => Promise<string>;
}

export async function loginAnthropic(opts: AnthropicLoginOptions): Promise<void> {
  const print = opts.print ?? ((l: string) => process.stdout.write(l + "\n"));
  const pkce = createPkce();
  const state = randomState();
  const url = buildAnthropicAuthUrl({ challenge: pkce.challenge, state });

  print("Opening your browser to sign in with your Claude (Pro/Max) account…");
  print(`If it doesn't open, paste this URL:\n  ${url}`);
  (opts.open ?? openBrowser)(url);
  print("\nAfter approving, the page shows an authorization code. Copy it and paste it here.");

  const pasted = await opts.readCode();
  const { code, state: pastedState } = parsePastedCode(pasted);
  if (!code) throw new Error("no code pasted");
  const tokens = await exchangeAnthropicCode(code, pastedState || state, pkce.verifier);

  saveTokens("anthropic", tokens, Vault.load());
  print("✓ Signed in with Claude — Anthropic will use your subscription (Bearer token in the vault).");
}

export async function refreshAnthropic(): Promise<void> {
  const vault = Vault.load();
  const cur = loadTokens("anthropic", vault);
  if (!cur?.refreshToken) throw new Error("not signed in with Claude — run `freecode auth login anthropic`");
  const next = await refreshAnthropicTokens(cur.refreshToken);
  if (!next.accessToken) throw new Error("refresh returned no access token — re-run `freecode auth login anthropic`");
  saveTokens("anthropic", next, vault);
}

export function logoutAnthropic(): void {
  clearTokens("anthropic");
}
