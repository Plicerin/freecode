// freecode should size compaction to a llama.cpp server's REAL loaded context
// (/props → n_ctx), not a 128k guess from the model name.
import { test, expect, describe } from "bun:test";
import { parseLlamaServerContext } from "../src/providers/local-context";

describe("parseLlamaServerContext", () => {
  test("reads the per-slot n_ctx from default_generation_settings", () => {
    const props = JSON.stringify({
      default_generation_settings: { n_ctx: 262144, n_predict: -1 },
      total_slots: 1,
      model_path: "C:/models/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
    });
    expect(parseLlamaServerContext(props)).toBe(262144);
  });

  test("falls back to the global n_ctx split across slots", () => {
    // No default_generation_settings — global 32768 across 2 slots = 16384/req.
    expect(parseLlamaServerContext(JSON.stringify({ n_ctx: 32768, total_slots: 2 }))).toBe(16384);
  });

  test("global n_ctx with no slot count is used as-is", () => {
    expect(parseLlamaServerContext(JSON.stringify({ n_ctx: 8192 }))).toBe(8192);
  });

  test("null on missing / non-positive / malformed", () => {
    expect(parseLlamaServerContext(JSON.stringify({ total_slots: 1 }))).toBeNull();
    expect(parseLlamaServerContext(JSON.stringify({ n_ctx: 0 }))).toBeNull();
    expect(parseLlamaServerContext("not json")).toBeNull();
  });
});
