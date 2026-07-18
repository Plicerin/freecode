// A local model server (ollama/llama-server/lmstudio) that accepts a request but
// never streams is almost always overloaded or out of VRAM — a big context on a
// full GPU can take 30s+ to the first token. The timeout message should SAY that
// for local providers, not offer cloud-only causes (rate limits) that can't apply.
import { test, expect, describe } from "bun:test";
import { streamTimeoutMessage } from "../src/providers/openai-compat";

describe("streamTimeoutMessage", () => {
  for (const id of ["ollama", "llama-server", "lmstudio"]) {
    test(`${id} (local): names VRAM / context, drops cloud-only rate-limit causes`, () => {
      const msg = streamTimeoutMessage(id, id, "some-model", "http://127.0.0.1:8080/v1");
      expect(msg).toMatch(/VRAM/i);
      expect(msg).toMatch(/context|num_ctx/i);
      expect(msg).not.toMatch(/rate|daily usage limit/i);
      expect(msg).toContain("some-model");
      expect(msg).toContain("http://127.0.0.1:8080/v1");
    });
  }

  for (const id of ["openai", "openrouter", "deepseek", "nim"]) {
    test(`${id} (cloud): keeps rate-limit / capacity phrasing, no VRAM talk`, () => {
      const msg = streamTimeoutMessage(id, id, "gpt", "https://api.example.com/v1");
      expect(msg).toMatch(/rate|capacity/i);
      expect(msg).not.toMatch(/VRAM/i);
    });
  }
});
