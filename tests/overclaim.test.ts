// The overclaim guard: flag a sweeping success claim that the evidence doesn't
// back (nothing verified, or a check failing) — surface the false green instead
// of burying it. Must NOT fire on modest claims or genuinely-verified work.
import { test, expect, describe } from "bun:test";
import { claimsSweepingSuccess, overclaimWarning } from "../src/agent/overclaim";

describe("claimsSweepingSuccess", () => {
  test("fires on sweeping completion language", () => {
    expect(claimsSweepingSuccess("All missing gameplay features have now been fully implemented.")).toBe(true);
    expect(claimsSweepingSuccess("Everything is done and all 23 tests pass.")).toBe(true);
    expect(claimsSweepingSuccess("The port is now fully functional.")).toBe(true);
    expect(claimsSweepingSuccess("Fixed all the issues you listed.")).toBe(true);
  });

  test("does NOT fire on modest, scoped statements", () => {
    expect(claimsSweepingSuccess("Fixed the typo in the header.")).toBe(false);
    expect(claimsSweepingSuccess("I changed one function and need to verify it.")).toBe(false);
    expect(claimsSweepingSuccess("Here's a first pass at the enemy spawner.")).toBe(false);
  });
});

describe("overclaimWarning", () => {
  const sweeping = "All missing gameplay features have now been fully implemented.";

  test("fires when a sweeping claim has nothing verified", () => {
    const w = overclaimWarning(sweeping, { changedCount: 1, verifiedCount: 0, anyFailed: false });
    expect(w).toBeTruthy();
    expect(w).toMatch(/no passing check|verified/i);
    expect(w).toMatch(/1 file/);
  });

  test("fires (hardest) when a check is failing", () => {
    const w = overclaimWarning(sweeping, { changedCount: 3, verifiedCount: 0, anyFailed: true });
    expect(w).toMatch(/FAILING/);
  });

  test("stays silent when a sweeping claim IS backed by a passing check", () => {
    expect(overclaimWarning(sweeping, { changedCount: 3, verifiedCount: 2, anyFailed: false })).toBeNull();
  });

  test("stays silent on a modest claim even with nothing verified", () => {
    expect(overclaimWarning("Fixed the typo.", { changedCount: 1, verifiedCount: 0, anyFailed: false })).toBeNull();
  });
});
