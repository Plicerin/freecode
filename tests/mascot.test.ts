import { test, expect } from "bun:test";
import { OWL, owlHalf, OWL_MICRO, MASCOT_NAME, MASCOT_BIO } from "../src/tui/mascot";

// The owl is rendered row-by-row with per-glyph coloring, so any misaligned
// row (a dropped or extra block from a future edit) would visibly break him.
test("owl rows are all the same width", () => {
  const widths = new Set(OWL.map((r) => [...r].length));
  expect(widths.size).toBe(1);
  expect([...widths][0]).toBeGreaterThan(0);
});

test("owl uses only the expected shading glyphs", () => {
  const allowed = new Set(["░", "▒", "▓", "█", " "]);
  for (const row of OWL) {
    for (const ch of row) expect(allowed.has(ch)).toBe(true);
  }
});

// The coloring trick depends on `█` being the eyes and nothing else — if a
// future edit introduces `█` elsewhere, the "glow only the eyes" logic breaks.
test("the solid █ glyph appears only in the eye rows", () => {
  const eyeRows = OWL.map((r, i) => (r.includes("█") ? i : -1)).filter((i) => i >= 0);
  // Eyes are a small contiguous band, not scattered through the body.
  expect(eyeRows.length).toBeGreaterThan(0);
  expect(eyeRows.length).toBeLessThanOrEqual(5);
  for (let i = 1; i < eyeRows.length; i++) {
    expect(eyeRows[i]! - eyeRows[i - 1]!).toBe(1); // contiguous
  }
});

// The startup banner uses the half-height owl (~50% smaller). It must keep the
// eyes, or the launch blink would have nothing to close.
test("owlHalf is ~half height and keeps the eyes", () => {
  expect(owlHalf().length).toBe(Math.ceil(OWL.length / 2));
  expect(owlHalf().length).toBeLessThan(OWL.length);
  expect(owlHalf().some((r) => r.includes("█"))).toBe(true);
});

test("Bubo's identity is intact", () => {
  expect(MASCOT_NAME).toBe("Bubo");
  expect(OWL_MICRO).toBe("(◉‿◉)");
  expect(MASCOT_BIO).toContain("Bubo");
  expect(MASCOT_BIO).toContain("Athena"); // the Clash of the Titans provenance
});
