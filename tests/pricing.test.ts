import { describe, it, expect } from "bun:test";
import { priceFor, estimateCost } from "../src/agent/pricing";

describe("pricing", () => {
  it("prices local providers as free", () => {
    expect(priceFor("qwen2.5:7b", "ollama")).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(priceFor("local-model", "lmstudio").input).toBe(0);
    expect(priceFor("mock-1", "mock").output).toBe(0);
  });

  it("distinguishes models by name", () => {
    expect(priceFor("claude-opus-4-1").output).toBe(75);
    expect(priceFor("claude-sonnet-4-5").output).toBe(15);
    expect(priceFor("gpt-4o-mini").input).toBe(0.15);
    expect(priceFor("gpt-4o").input).toBe(2.5);
    expect(priceFor("gemini-2.0-flash").input).toBe(0.1);
  });

  it("falls back to a blended estimate for unknown remote models", () => {
    expect(priceFor("some-new-model")).toEqual({ input: 3, output: 15 });
  });

  it("computes cost from usage", () => {
    const cost = estimateCost(
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      { input: 3, output: 15 },
    );
    expect(cost).toBeCloseTo(18, 5);
    // Local model costs nothing.
    expect(estimateCost(
      { input: 5_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      priceFor("qwen2.5:7b", "ollama"),
    )).toBe(0);
  });
});
