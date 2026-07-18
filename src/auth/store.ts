// OAuth token storage. Tokens are secrets, so they live in the same encrypted
// vault as API keys — under a distinct `oauth:<provider>` namespace so they never
// collide with a key the user also set. A small wrapper around Vault keeps the
// JSON (de)serialisation in one place.
import { Vault } from "../config/vault";
import type { TokenSet } from "./oauth";

function vaultKey(provider: string): string {
  return `oauth:${provider}`;
}

export function saveTokens(provider: string, tokens: TokenSet, vault: Vault = Vault.load()): void {
  vault.set(vaultKey(provider), JSON.stringify(tokens));
}

export function loadTokens(provider: string, vault: Vault = Vault.load()): TokenSet | undefined {
  const raw = vault.get(vaultKey(provider));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as TokenSet;
  } catch {
    return undefined;
  }
}

export function clearTokens(provider: string, vault: Vault = Vault.load()): boolean {
  return vault.remove(vaultKey(provider));
}

export function hasTokens(provider: string, vault: Vault = Vault.load()): boolean {
  return loadTokens(provider, vault) !== undefined;
}
