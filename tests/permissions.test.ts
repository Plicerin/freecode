// Permission approvals: the keypress→decision mapping (the source of the
// "always didn't persist" bug — `a` used to mean allow-once) and the engine's
// allow-always persistence (which was never broken, but is the contract that
// makes the keypress fix matter).
import { test, expect, describe } from "bun:test";
import { approvalDecisionForKey, createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";

describe("approvalDecisionForKey — conventional mapping", () => {
  test("y = allow once, a = allow always, n/d/esc = deny", () => {
    expect(approvalDecisionForKey("y", false)).toBe("allow");
    expect(approvalDecisionForKey("Y", false)).toBe("allow"); // case-insensitive
    expect(approvalDecisionForKey("a", false)).toBe("allow-always");
    expect(approvalDecisionForKey("n", false)).toBe("deny");
    expect(approvalDecisionForKey("d", false)).toBe("deny");
    expect(approvalDecisionForKey(undefined, true)).toBe("deny"); // esc
  });
  test("any other key is ignored (null)", () => {
    expect(approvalDecisionForKey("x", false)).toBeNull();
    expect(approvalDecisionForKey("", false)).toBeNull();
  });
});

describe("permission engine — allow-always persists, allow-once does not", () => {
  const req = (command: string) => ({ tool: "Bash", argsSummary: `{"command":"${command}"}` });

  test("allow-always caches the tool — later calls don't re-prompt", async () => {
    const eng = createPermissionEngine("manual", (async () => "allow") as ApprovalCallback);
    expect(await eng.decide(req("ls"), (async () => "allow-always") as ApprovalCallback)).toBe("allow");
    let asked = false;
    const d = await eng.decide(req("pwd"), (async () => { asked = true; return "deny"; }) as ApprovalCallback);
    expect(asked).toBe(false); // never re-prompted
    expect(d).toBe("allow");
  });

  test("allow (once) does NOT cache — the next call re-prompts", async () => {
    const eng = createPermissionEngine("manual", (async () => "allow") as ApprovalCallback);
    await eng.decide(req("ls"), (async () => "allow") as ApprovalCallback);
    let asked = false;
    await eng.decide(req("pwd"), (async () => { asked = true; return "deny"; }) as ApprovalCallback);
    expect(asked).toBe(true); // correctly asked again
  });
});
