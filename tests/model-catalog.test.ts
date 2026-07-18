// OpenAICompatProvider.modelCatalog parses the rich /models metadata OpenRouter
// returns (pricing, expiration_date, architecture) so the picker can drop
// expired/generation models and mark free ones by ACTUAL price — not the name.
import { test, expect, describe, afterEach } from "bun:test";
import { OpenAICompatProvider } from "../src/providers/openai-compat";

const realFetch = globalThis.fetch;
function stubModels(data: unknown[]): void {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ data }),
    text: async () => "",
  } as unknown as Response)) as unknown as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

const prov = () => new OpenAICompatProvider("openrouter", "OpenRouter", { baseUrl: "http://x/v1", providerName: "openrouter", defaultModel: "d" });

describe("OpenAICompatProvider.modelCatalog", () => {
  test("derives free from pricing, available from expiration, chat from output modality", async () => {
    stubModels([
      { id: "free-chat", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] } },
      { id: "paid-chat", pricing: { prompt: "0.000002", completion: "0.000006" }, architecture: { output_modalities: ["text"] } },
      { id: "music", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text", "audio"] } },
      { id: "expired", pricing: { prompt: "0", completion: "0" }, expiration_date: "2000-01-01", architecture: { output_modalities: ["text"] } },
    ]);
    const by = Object.fromEntries((await prov().modelCatalog()).map((c) => [c.id, c]));
    expect(by["free-chat"]!.free).toBe(true);
    expect(by["free-chat"]!.chat).toBe(true);
    expect(by["free-chat"]!.available).toBeUndefined(); // no expiration → unknown (treated as available)
    expect(by["paid-chat"]!.free).toBe(false);
    expect(by["music"]!.free).toBe(true);
    expect(by["music"]!.chat).toBe(false); // outputs audio → not a chat model
    expect(by["expired"]!.available).toBe(false); // past its expiration_date
  });

  test("fields stay undefined when the endpoint returns only ids (NIM / Ollama style)", async () => {
    stubModels([{ id: "meta/llama-3.1-70b" }]);
    const c = (await prov().modelCatalog())[0]!;
    expect(c.id).toBe("meta/llama-3.1-70b");
    expect(c.free).toBeUndefined();
    expect(c.available).toBeUndefined();
    expect(c.chat).toBeUndefined();
  });

  test("models() still returns sorted bare ids (unchanged behaviour)", async () => {
    stubModels([{ id: "b" }, { id: "a" }]);
    expect(await prov().models()).toEqual(["a", "b"]);
  });
});
