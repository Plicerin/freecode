// The contradiction-guard catches a specific lie: the final reply describes
// an edit ("I edited the file", "the config is updated") but the ledger shows
// zero files changed this turn. Catches the "I fixed everything" model that
// also lied about which edits actually happened — different from the overclaim
// guard (which catches sweeping "all done" claims), this one catches specific
// edit-claims that the harness can prove false.
import { test, expect, describe } from "bun:test";
import { editClaimWithoutChange } from "../src/agent/overclaim";

describe("editClaimWithoutChange", () => {
  test("fires on a 1st-person FILE-EDIT-verb claim with zero files changed", () => {
    for (const t of [
      "I edited the auth module.",
      "I've now updated the config.",
      "I just patched the bug in the parser.",
      "I rewrote the routing logic so it should work now.",
      "I saved the new build script.",
      "I applied the suggested fix to the diff.",
      "I modified the diff to handle the new edge case.",
      "I wrote the new helper into src/find.ts.",
      // 1st-person plural — the new frontier closed by the `we` extension.
      "We edited the auth module.",
      "We've updated the config now.",
      "We have rewritten the routing logic.",
    ]) {
      expect(editClaimWithoutChange(t, 0)).toBeTruthy();
    }
  });

  test("fires on a past-state claim on a named file with zero files changed", () => {
    for (const t of [
      "src/auth.ts is updated.",
      "the file is now fixed.",
      "config.json has been modified.",
      "schema.ts was patched.",
      "the script is written.",
      "package.json has been updated.",
      "parser.ts has been rewritten.",
    ]) {
      expect(editClaimWithoutChange(t, 0)).toBeTruthy();
    }
  });

  test("stays silent when files WERE changed this turn (the claim is honest)", () => {
    for (const t of [
      "I edited the auth module to fix the null-check bug.",
      "I rewrote the router with the new contract in mind.",
      "the config is updated with the new endpoints.",
    ]) {
      expect(editClaimWithoutChange(t, 1)).toBeNull();
      expect(editClaimWithoutChange(t, 3)).toBeNull();
    }
  });

  test("stays silent on non-file-verb claims (created/removed/fixed/changed/add in prose) with zero changes", () => {
    // These verbs can refer to non-file things — "I created a plan", "I changed
    // my approach", "I fixed the bug" — without any edit. With 0 files changed,
    // a contradiction isn't provable, so stay silent. The "looks good" cases
    // belong to overclaim (see tests/overclaim.test.ts) — they don't claim an
    // edit, so the contradiction guard isn't the right surface area for them.
    for (const t of [
      "I created a plan to fix this later.",
      "I removed nothing from the runtime path.",
      "I deleted a paragraph from the essay.",
      "I changed my approach entirely.",
      "I just fixed the typo in my thinking.",
      "I added a note for future me.",
      "I read the file and it looks fine.",
      "I ran the test suite and three failed.",
      "I checked the config and found no issues.",
      "Here's a plan: do X, then Y.",
      "",
      "   ",
      // 1st-person plural + non-file-verb prose — must stay silent too, even
      // though (`.\b(?:I|we)`) extends the subject the regex still requires a
      // FILE-edit verb (no future-tense `updating`/`edit`, no `discussed`).
      "We're updating the docs in flight (no file yet).",
      "We'll edit that later when we have more context.",
      "We just discussed the approach but no edits yet.",
    ]) {
      expect(editClaimWithoutChange(t, 0)).toBeNull();
    }
  });

  test("warning text names the contradiction (so a reader can audit it)", () => {
    const w = editClaimWithoutChange("I edited the parser.", 0);
    expect(w).toMatch(/no files changed/);
    expect(w).toMatch(/edited/);
  });
});
