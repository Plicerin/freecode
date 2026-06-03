import { test, expect } from "bun:test";
import { nextConfidence, type Confidence } from "../src/tui/confidence";

const led = (verified: string[], believed: string[]) => ({ verified, believed });

test("changes that passed checks → verified", () => {
  expect(nextConfidence("unchecked", led(["bun run typecheck passed"], []))).toBe("verified");
});

test("changes without checks → unverified (the honest debt)", () => {
  expect(nextConfidence("verified", led([], ["changed 2 file(s) without running checks — unverified"]))).toBe("unverified");
});

test("checks failing → failing, regardless of prior state", () => {
  expect(nextConfidence("verified", led([], ["checks failing — changes unconfirmed"]))).toBe("failing");
});

test("read-only turn is STICKY — leaves the prior state untouched", () => {
  // only 'observed' activity, no verified/believed → must not reset confidence
  const states: Confidence[] = ["unchecked", "verified", "unverified", "failing"];
  for (const s of states) expect(nextConfidence(s, led([], []))).toBe(s);
});

test("a later passing check clears earlier unverified debt", () => {
  let c: Confidence = "unchecked";
  c = nextConfidence(c, led([], ["changed 1 file(s) without running checks — unverified"]));
  expect(c).toBe("unverified");
  c = nextConfidence(c, led(["bun test passed"], []));
  expect(c).toBe("verified"); // current state is now confirmed — history doesn't taint it
});
