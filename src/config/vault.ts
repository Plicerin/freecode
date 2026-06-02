import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { VAULT_PATH, APP_DIR } from "../utils/paths";

interface VaultFile {
  v: number;
  salt: string; // base64
  iv: string; // base64
  tag: string; // base64
  data: string; // base64 ciphertext of JSON { provider: key }
}

const VERSION = 1;
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM nonce

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN);
}

/**
 * Encrypted secret store for provider API keys. AES-256-GCM with a key derived
 * from a master passphrase via scrypt. No plaintext keys ever touch disk.
 */
export class Vault {
  private secrets: Record<string, string> = {};

  private constructor(
    private readonly passphrase: string,
    private readonly path: string,
  ) {}

  static exists(path: string = VAULT_PATH): boolean {
    return existsSync(path);
  }

  /** Open (or create) the vault and decrypt it. Throws on a wrong passphrase. */
  static open(passphrase: string, path: string = VAULT_PATH): Vault {
    const vault = new Vault(passphrase, path);
    if (existsSync(path)) {
      const file = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
      const key = deriveKey(passphrase, Buffer.from(file.salt, "base64"));
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
      decipher.setAuthTag(Buffer.from(file.tag, "base64"));
      let plain: string;
      try {
        plain = decipher.update(Buffer.from(file.data, "base64"), undefined, "utf8") + decipher.final("utf8");
      } catch {
        throw new Error("Could not unlock vault — wrong passphrase?");
      }
      vault.secrets = JSON.parse(plain) as Record<string, string>;
    }
    return vault;
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

  remove(provider: string): boolean {
    if (!(provider in this.secrets)) return false;
    delete this.secrets[provider];
    this.save();
    return true;
  }

  private save(): void {
    if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true });
    else if (!existsSync(dirname(this.path))) mkdirSync(dirname(this.path), { recursive: true });
    const salt = randomBytes(16);
    const iv = randomBytes(IV_LEN);
    const key = deriveKey(this.passphrase, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.secrets), "utf8"), cipher.final()]);
    const file: VaultFile = {
      v: VERSION,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    };
    writeFileSync(this.path, JSON.stringify(file), "utf8");
    try { chmodSync(this.path, 0o600); } catch { /* best effort (no-op on Windows) */ }
  }
}
