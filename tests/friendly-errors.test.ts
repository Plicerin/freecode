// The "MODEL not found and won't work again, even if you switch models" bug: the
// old friendlyError mapped EVERY 404 to "Model not found — use /model", which sent
// the user switching models in circles when the real cause was a dead/wrong endpoint
// or a crashed local server (neither of which a model switch can fix). These pin the
// two distinct branches — a genuine model_not_found vs a bare 404 — and that the
// model name is threaded through so the message names the actual model.
import { test, expect, describe } from "bun:test";
import { friendlyError } from "../src/providers/friendly-errors";

const err = (message: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(message), extra);

describe("friendlyError: 404 vs model_not_found are distinct (no more 'switch models' dead-end)", () => {
  test("a genuine model_not_found blames the model and points at /model", () => {
    const f = friendlyError(err("model not found"), "openrouter", "z-ai/glm-4.6");
    expect(f.message).toMatch(/not found on openrouter/i);
    expect(f.message).toMatch(/glm-4\.6/);            // names the actual model
    expect(f.message).toMatch(/\/model/);             // switching models is the right advice HERE
  });

  test("model_not_found via the provider `code` field is recognised too", () => {
    const f = friendlyError(err("400 bad request", { code: "model_not_found" }), "nim", "deepseek-ai/deepseek-r1");
    expect(f.message).toMatch(/deepseek-r1/);
    expect(f.message).toMatch(/not found on nim/i);
  });

  test("a bare 404 does NOT claim the model is missing — it names the endpoint/server as the likely cause", () => {
    const f = friendlyError(err("404 Not Found", { status: 404 }), "openrouter", "some/model");
    // Must mention the endpoint/server so the user stops switching models in circles.
    expect(f.message).toMatch(/endpoint|baseUrl|server/i);
    expect(f.message).toMatch(/404/);
    expect(f.message).toMatch(/some\/model/);         // still names the model for context
    // It must NOT assert the model is "not found" as the definitive cause.
    expect(f.message).not.toMatch(/^Model .* not found/);
  });

  test("without a model name both branches still produce a sensible message", () => {
    expect(friendlyError(err("model not found"), "gemini").message).toMatch(/not found on gemini/i);
    expect(friendlyError(err("404", { status: 404 }), "gemini").message).toMatch(/404/);
  });
});
