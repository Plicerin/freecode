import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { VAULT_PATH, VAULT_KEY_PATH, APP_DIR } from "../utils/paths";

type Mode = "device" | "passphrase";

interface VaultFile {
  v: number;
  mode: Mode;
  salt?: string; // base64 (passphrase mode only)
  iv: string; // base64
  tag: string; // base64
  data: string; // base64 ciphertext of JSON { provider: key }
}

const VERSION = 1;
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM nonce

function ensureAppDir(): void {
  if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true });
}

/** A per-machine random key, generated once, protected by file permissions.
 * Lets the vault auto-unlock (no passphrase) — "set once, never again". */
function deviceKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  }
  ensureAppDir();
  const k = randomBytes(KEY_LEN);
  writeFileSync(keyPath, k.toString("base64"), "utf8");
  try { chmodSync(keyPath, 0o600); } catch { /* no-op on Windows */ }
  return k;
}

function passphraseKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN);
}

/**
 * Encrypted provider-key store at ~/.freecode/vault.json (AES-256-GCM).
 * Two modes, auto-selected:
 *   - device (default): key from ~/.freecode/vault.key — auto-unlocks, no prompt.
 *   - passphrase: key derived from FREECODE_VAULT_PASSPHRASE via scrypt.
 */
export class Vault {
  private secrets: Record<string, string> = {};

  private constructor(
    private readonly mode: Mode,
    private readonly passphrase: string | undefined,
    private readonly path: string,
    private readonly keyPath: string,
  ) {}

  static exists(path: string = VAULT_PATH): boolean {
    return existsSync(path);
  }

  /** Open the existing vault or create a fresh one, choosing the mode itself. */
  static load(path: string = VAULT_PATH, keyPath: string = VAULT_KEY_PATH): Vault {
    const envPass = process.env.FREECODE_VAULT_PASSPHRASE;
    if (existsSync(path)) {
      const file = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
      let key: Buffer;
      let vault: Vault;
      if (file.mode === "passphrase") {
        if (!envPass) throw new Error("Vault is passphrase-protected — set FREECODE_VAULT_PASSPHRASE to unlock it.");
        key = passphraseKey(envPass, Buffer.from(file.salt ?? "", "base64"));
        vault = new Vault("passphrase", envPass, path, keyPath);
      } else {
        key = deviceKey(keyPath);
        vault = new Vault("device", undefined, path, keyPath);
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
      decipher.setAuthTag(Buffer.from(file.tag, "base64"));
      try {
        const plain = decipher.update(Buffer.from(file.data, "base64"), undefined, "utf8") + decipher.final("utf8");
        vault.secrets = JSON.parse(plain) as Record<string, string>;
      } catch {
        throw new Error("Could not unlock vault — wrong passphrase or corrupted key.");
      }
      return vault;
    }
    // New vault: passphrase mode iff the env passphrase is set, else device mode.
    return envPass
      ? new Vault("passphrase", envPass, path, keyPath)
      : new Vault("device", undefined, path, keyPath);
  }

  get(provider: string): string | undefined {
    return this.secrets[provider];
  }

  list(): string[] {
    return Object.keys(this.secrets).sort();
  }

  set(provider: string, key: string): void {
    this.secrets[provider] = key;
    this.save();
  }

  setMany(entries: Record<string, string>): void {
    Object.assign(this.secrets, entries);
    this.save();
  }

  remove(provider: string): boolean {
    if (!(provider in this.secrets)) return false;
    delete this.secrets[provider];
    this.save();
    return true;
  }

  private save(): void {
    ensureAppDir();
    const iv = randomBytes(IV_LEN);
    let key: Buffer;
    let salt: string | undefined;
    if (this.mode === "passphrase") {
      const s = randomBytes(16);
      salt = s.toString("base64");
      key = passphraseKey(this.passphrase!, s);
    } else {
      key = deviceKey(this.keyPath);
    }
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.secrets), "utf8"), cipher.final()]);
    const file: VaultFile = {
      v: VERSION,
      mode: this.mode,
      ...(salt ? { salt } : {}),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    };
    writeFileSync(this.path, JSON.stringify(file), "utf8");
    try { chmodSync(this.path, 0o600); } catch { /* no-op on Windows */ }
  }
}
