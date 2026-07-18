// Ollama loads a model with a fixed num_ctx that's usually far below the
// name-based guess (a qwen name → 128k while it's loaded at 65k). /api/ps
// reports the real loaded size; parse it so the context meter + compaction size
// to reality instead of overrunning the true window.
import { test, expect, describe } from "bun:test";
import { parseOllamaLoadedContext } from "../src/providers/local-context";

// The exact shape Ollama's /api/ps returns (trimmed).
const PS = JSON.stringify({
  models: [{
    name: "qwen3.5:9b", model: "qwen3.5:9b", size: 7717236243,
    details: { family: "qwen35", parameter_size: "9.7B", quantization_level: "Q4_K_M" },
    context_length: 65536,
  }],
});

describe("parseOllamaLoadedContext", () => {
  test("reads the loaded context_length for the model, by name", () => {
    expect(parseOllamaLoadedContext(PS, "qwen3.5:9b")).toBe(65536);
  });
  test("matches on the `model` field too", () => {
    expect(parseOllamaLoadedContext(JSON.stringify({ models: [{ model: "llama3.2:latest", context_length: 8192 }] }), "llama3.2:latest")).toBe(8192);
  });
  test("returns null when the requested model isn't loaded", () => {
    expect(parseOllamaLoadedContext(PS, "some-other-model")).toBeNull();
  });
  test("returns null on absent / non-positive context_length or garbage", () => {
    expect(parseOllamaLoadedContext(JSON.stringify({ models: [{ name: "m" }] }), "m")).toBeNull();
    expect(parseOllamaLoadedContext(JSON.stringify({ models: [{ name: "m", context_length: 0 }] }), "m")).toBeNull();
    expect(parseOllamaLoadedContext("not json", "m")).toBeNull();
    expect(parseOllamaLoadedContext(JSON.stringify({}), "m")).toBeNull();
  });
});
