// PKCE (RFC 7636) — the security backbone of the "Sign in with ChatGPT" flow.
// A public CLI can't keep a client secret, so instead it generates a random
// `code_verifier`, sends only its SHA-256 hash (`code_challenge`) to the
// authorize endpoint, and proves possession by sending the raw verifier at token
// exchange. An intercepted authorization code is then useless without the
// verifier. All pure + deterministic given the random bytes, so it's testable
// against the RFC's own vectors.
import { createHash, randomBytes } from "node:crypto";

/** RFC 4648 §5 base64url (no padding) — the encoding PKCE + OAuth state use. */
export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A high-entropy code_verifier (RFC 7636 §4.1: 43–128 chars from the unreserved set). */
export function generateVerifier(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** S256 challenge = base64url(SHA256(verifier)). Deterministic — the testable core. */
export function challengeFromVerifier(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Opaque random value to bind the redirect to this request (CSRF defense). */
export function randomState(bytes = 16): string {
  return base64url(randomBytes(bytes));
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function createPkce(): Pkce {
  const verifier = generateVerifier();
  return { verifier, challenge: challengeFromVerifier(verifier), method: "S256" };
}
