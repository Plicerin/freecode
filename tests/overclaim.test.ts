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

  test("fires on the short-form sweeps that broadened regex catches", () => {
    // Originally these slipped the regex entirely — flagged in the handover.
    expect(claimsSweepingSuccess("The app is now fully rebuilt and ships cleanly.")).toBe(true);
    expect(claimsSweepingSuccess("All good — ready to commit.")).toBe(true);
    expect(claimsSweepingSuccess("Ready to ship the build now.")).toBe(true);
    expect(claimsSweepingSuccess("build succeeded\nEverything works.")).toBe(true);
    expect(claimsSweepingSuccess("Everything's good now.")).toBe(true);
    expect(claimsSweepingSuccess("Every issue is resolved.")).toBe(true);
  });

  test("does NOT fire on modest, scoped statements", () => {
    expect(claimsSweepingSuccess("Fixed the typo in the header.")).toBe(false);
    expect(claimsSweepingSuccess("I changed one function and need to verify it.")).toBe(false);
    expect(claimsSweepingSuccess("Here's a first pass at the enemy spawner.")).toBe(false);
  });

  test("does NOT fire on modest 'looks good' prose — `good` was hoisted to STRONG-only so a casual status report doesn't trip", () => {
    // Regression lock-in: if someone adds `good` back to SWEEPING's verb list,
    // these cases would start tripping again ('everything' + 'good' would match
    // the broad SWEEPING pattern). They pass today because SWEEPING's verbs are
    // status-of-completion only (implemented/done/working/...) and STRONG only
    // matches the sweeping `all good` / `everything's good` forms, not the
    // casual `looks good to me` phrasing.
    expect(claimsSweepingSuccess("Everything looks good on first read.")).toBe(false);
    expect(claimsSweepingSuccess("This looks good — moving on.")).toBe(false);
    expect(claimsSweepingSuccess("Looks good to me.")).toBe(false);
    expect(claimsSweepingSuccess("The diff looks good; the rest is straightforward.")).toBe(false);
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

  test("fires on broadened sweep patterns too", () => {
    // The case the handover flagged: 'fully rebuilt'.
    expect(overclaimWarning("Fully rebuilt and working.", { changedCount: 0, verifiedCount: 0, anyFailed: false }))
      .toMatch(/no passing check/);
    // ready to ship
    expect(overclaimWarning("Ready to ship", { changedCount: 1, verifiedCount: 0, anyFailed: false }))
      .toBeTruthy();
  });

  test("stays silent on a modest claim even with nothing verified", () => {
    expect(overclaimWarning("Fixed the typo.", { changedCount: 1, verifiedCount: 0, anyFailed: false })).toBeNull();
  });
});
