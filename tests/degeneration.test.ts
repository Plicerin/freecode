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
});
