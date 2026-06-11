// The stream-degeneration guard: trips on runaway repetition (so freecode aborts
// instead of streaming garbage until esc), but NEVER on legitimate output.
import { test, expect, describe } from "bun:test";
import { degenerationReason, isDegenerate } from "../src/agent/degeneration";

describe("trips on real degeneration", () => {
  test("a single character looped thousands of times", () => {
    expect(isDegenerate("starting the work…\n" + "L".repeat(3000))).toBe(true);
  });

  test("a long char run broken only by newlines (the observed 'space vikings' shape)", () => {
    const block = ("LLLLLLLLLLLLLLLLLLLL\n".repeat(60)); // 60 lines of L's
    expect(isDegenerate("here goes\n" + block)).toBe(true);
  });

  test("a tiny token set looped forever", () => {
    const garbage = "VodafoneLCT spousesT_ embassy footnotes ".repeat(120);
    const r = degenerationReason("ok\n" + garbage);
    expect(r).not.toBeNull();
    expect(r).toContain("distinct");
  });
});

describe("does NOT trip on legitimate output", () => {
  test("short replies are never judged", () => {
    expect(isDegenerate("Done. I edited the file and the tests pass.")).toBe(false);
    expect(isDegenerate("GOAL: CONTINUE")).toBe(false);
  });

  test("a markdown divider / box-drawing line amid varied prose", () => {
    const para = Array.from({ length: 40 }, (_, i) =>
      `Section ${i} covers how module ${String.fromCharCode(97 + (i % 26))} initializes its state before render.`).join(" ");
    const doc = "# Title\n\n" + "-".repeat(80) + "\n\n" + para;
    expect(isDegenerate(doc)).toBe(false);
  });

  test("real code with varied tokens, even when long", () => {
    const code = Array.from({ length: 120 }, (_, i) =>
      `  const value${i} = compute(${i}, options.scale) + offset${i % 7};`).join("\n");
    expect(isDegenerate(code)).toBe(false);
  });

  test("a long base64-ish blob (varied chars, no long run)", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let blob = "data: ";
    for (let i = 0; i < 2000; i++) blob += alphabet[(i * 7 + (i % 13)) % alphabet.length];
    expect(isDegenerate(blob)).toBe(false);
  });

  test("legitimately repetitive prose stays under the distinct-token floor", () => {
    // Repeated phrasing, but plenty of distinct words across the window.
    const prose = "The renderer projects each vertex onto the screen plane. ".repeat(15) +
      "It then clips against the frustum and rasterizes the visible triangles into the framebuffer.";
    expect(isDegenerate(prose)).toBe(false);
  });

  // The block-loop case from a real /goal run: a multi-line paragraph re-emitted
  // forever. It has enough distinct words to slip past the token-distinct check,
  // so the LINE-level check must catch it.
  const LOOP_BLOCK = [
    "I have refactored the audio module to use the class name AudioEngine and a clean named export audio. This resolves the SyntaxError by removing the conflict with the native Audio object.",
    "Next steps:",
    "1. Verify Visuals: Ensure the planetScene and orbitScene are displaying the correct data.",
    "2. Final Synthesis: Complete any remaining minor logic.",
    "GOAL: CONTINUE",
  ].join("\n");

  test("a multi-line block looped many times (the GOAL: CONTINUE loop)", () => {
    const reason = degenerationReason(LOOP_BLOCK.repeat(8));
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/looping/);
  });

  test("the same block looped only twice is NOT yet flagged (not unambiguous)", () => {
    // Two repeats is too few to be sure — keep it under the floor.
    expect(isDegenerate(LOOP_BLOCK + "\n" + LOOP_BLOCK)).toBe(false);
  });

  test("a long, varied multi-line answer (distinct lines) is not flagged", () => {
    const real = Array.from({ length: 30 }, (_, i) =>
      `Step ${i}: ${["read", "edit", "run", "check", "verify"][i % 5]} the ${["loader", "parser", "renderer", "tracker", "vault"][i % 5]} at src/mod${i}.ts and confirm result ${i}.`).join("\n");
    expect(isDegenerate(real)).toBe(false);
  });
});
