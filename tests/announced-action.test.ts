// The "stops mid-task" failure: a weak model announces its next step in prose
// ("I'll check the contents of …") and ends its turn with no tool call. The loop
// must recognize that and nudge it to continue instead of surrendering the turn.
// This guards the detector that drives the nudge.
import { test, expect, describe } from "bun:test";
import { announcedNextActionWithoutCalling } from "../src/agent/text-tool-call";

describe("announcedNextActionWithoutCalling — should nudge", () => {
  test("the reported case and its kin", () => {
    for (const t of [
      "I see a src directory within openrocket/core. I'll check the contents of openrocket/core/src/main to see the source code structure.",
      "Let me look at the package.json to understand the build.",
      "Next, I'll run the test suite to confirm.",
      "Now I'll search for the planet rendering code.",
      "I'm going to read the main entry file.",
      "I need to inspect the config before proceeding.",
      "Here's my plan:", // ended on a bare colon → was about to continue
      "Let me examine the following files:",
    ]) {
      expect(announcedNextActionWithoutCalling(t)).toBe(true);
    }
  });
});

describe("announcedNextActionWithoutCalling — should NOT nudge (genuine answers)", () => {
  test("final answers and conclusions don't trigger", () => {
    for (const t of [
      "The structure has three modules: core, swing, and android. That's the full layout.",
      "Done — the build passes and all tests are green.",
      "I checked the file and there's no issue; it's already correct.",
      "I'll let you know if anything else comes up.", // no action verb after the intent
      "The bug was a null check; I fixed it and verified the suite passes.",
      "",
      "   ",
    ]) {
      expect(announcedNextActionWithoutCalling(t)).toBe(false);
    }
  });
});
