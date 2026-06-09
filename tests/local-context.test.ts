// Reading a local server's ACTUAL loaded context (LM Studio) so freecode sizes
// compaction to reality instead of the model's name-based max.
import { test, expect, describe } from "bun:test";
import { parseLmStudioContext } from "../src/providers/local-context";

const payload = JSON.stringify({
  data: [
    { id: "google/gemma-3-4b", state: "loaded", loaded_context_length: 4096, max_context_length: 131072 },
    { id: "lfm2.5-8b-a1b", state: "not-loaded", max_context_length: 128000 },
  ],
});

describe("parseLmStudioContext", () => {
  test("returns the loaded context for the requested, loaded model", () => {
    expect(parseLmStudioContext(payload, "google/gemma-3-4b")).toBe(4096);
  });
  test("falls back to whatever IS loaded when the id isn't matched/loaded", () => {
    expect(parseLmStudioContext(payload, "lfm2.5-8b-a1b")).toBe(4096); // gemma is the loaded one
  });
  test("null when nothing is loaded", () => {
    expect(parseLmStudioContext(JSON.stringify({ data: [{ id: "x", state: "not-loaded" }] }), "x")).toBeNull();
  });
  test("null on junk / missing field", () => {
    expect(parseLmStudioContext("not json", "x")).toBeNull();
    expect(parseLmStudioContext(JSON.stringify({ data: [{ id: "x", state: "loaded" }] }), "x")).toBeNull();
  });
  test("tolerates a bare array (no data wrapper)", () => {
    expect(parseLmStudioContext(JSON.stringify([{ id: "x", state: "loaded", loaded_context_length: 8192 }]), "x")).toBe(8192);
  });
});
