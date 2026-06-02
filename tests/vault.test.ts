import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/config/vault";

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "oc-vault-"));
  return { vault: join(dir, "vault.json"), key: join(dir, "vault.key") };
}

afterEach(() => { delete process.env.FREECODE_VAULT_PASSPHRASE; });

describe("Vault — device mode (no passphrase)", () => {
  it("auto-unlocks and round-trips across reopen", () => {
    const p = paths();
    const v = Vault.load(p.vault, p.key);
    v.setMany({ anthropic: "sk-ant-secret", openai: "sk-oai-secret" });
    const v2 = Vault.load(p.vault, p.key); // no passphrase needed
    expect(v2.get("anthropic")).toBe("sk-ant-secret");
    expect(v2.list()).toEqual(["anthropic", "openai"]);
  });

  it("removes a secret", () => {
    const p = paths();
    const v = Vault.load(p.vault, p.key);
    v.set("gemini", "AIza-x");
    expect(v.remove("gemini")).toBe(true);
    expect(v.remove("gemini")).toBe(false);
    expect(Vault.load(p.vault, p.key).get("gemini")).toBeUndefined();
  });

  it("never writes a key in plaintext", () => {
    const p = paths();
    Vault.load(p.vault, p.key).set("openai", "sk-PLAINTEXT-MARKER");
    expect(readFileSync(p.vault, "utf8")).not.toContain("sk-PLAINTEXT-MARKER");
  });
});

describe("Vault — passphrase mode", () => {
  it("uses FREECODE_VAULT_PASSPHRASE and rejects a wrong one", () => {
    const p = paths();
    process.env.FREECODE_VAULT_PASSPHRASE = "correct-horse";
    Vault.load(p.vault, p.key).set("openai", "sk-x");
    expect(Vault.load(p.vault, p.key).get("openai")).toBe("sk-x");
    process.env.FREECODE_VAULT_PASSPHRASE = "wrong";
    expect(() => Vault.load(p.vault, p.key)).toThrow(/unlock|passphrase|corrupted/i);
    delete process.env.FREECODE_VAULT_PASSPHRASE;
    expect(() => Vault.load(p.vault, p.key)).toThrow(/passphrase-protected/i);
  });
});
