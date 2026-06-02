import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/config/vault";

function tmpVault() { return join(mkdtempSync(join(tmpdir(), "oc-vault-")), "vault.json"); }

describe("Vault", () => {
  it("stores and retrieves a secret across reopen", () => {
    const p = tmpVault();
    const v = Vault.open("hunter2", p);
    v.set("anthropic", "sk-ant-secret");
    v.set("openai", "sk-oai-secret");
    // reopen with the same passphrase
    const v2 = Vault.open("hunter2", p);
    expect(v2.get("anthropic")).toBe("sk-ant-secret");
    expect(v2.list().sort()).toEqual(["anthropic", "openai"]);
  });

  it("rejects a wrong passphrase", () => {
    const p = tmpVault();
    Vault.open("correct", p).set("openai", "sk-x");
    expect(() => Vault.open("wrong", p)).toThrow(/unlock|passphrase/i);
  });

  it("removes a secret", () => {
    const p = tmpVault();
    const v = Vault.open("pw", p);
    v.set("gemini", "AIza-x");
    expect(v.remove("gemini")).toBe(true);
    expect(v.remove("gemini")).toBe(false);
    expect(Vault.open("pw", p).get("gemini")).toBeUndefined();
  });

  it("does not store keys in plaintext on disk", () => {
    const p = tmpVault();
    Vault.open("pw", p).set("openai", "sk-PLAINTEXT-MARKER");
    const raw = require("node:fs").readFileSync(p, "utf8");
    expect(raw).not.toContain("sk-PLAINTEXT-MARKER");
  });
});
