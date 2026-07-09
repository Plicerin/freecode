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
    const eng = createPermissionEngine("manual");
    expect(await eng.decide(req("ls"), (async () => "allow-always") as ApprovalCallback)).toBe("allow");
    let asked = false;
    const d = await eng.decide(req("pwd"), (async () => { asked = true; return "deny"; }) as ApprovalCallback);
    expect(asked).toBe(false); // never re-prompted
    expect(d).toBe("allow");
  });

  test("allow (once) does NOT cache — the next call re-prompts", async () => {
    const eng = createPermissionEngine("manual");
    await eng.decide(req("ls"), (async () => "allow") as ApprovalCallback);
    let asked = false;
    await eng.decide(req("pwd"), (async () => { asked = true; return "deny"; }) as ApprovalCallback);
    expect(asked).toBe(true); // correctly asked again
  });

  test("setMode keeps prior allow-always grants (a provider/model switch must not forget them)", async () => {
    const eng = createPermissionEngine("manual");
    expect(await eng.decide({ tool: "WebFetch", argsSummary: "{}" }, (async () => "allow-always") as ApprovalCallback)).toBe("allow");
    eng.setMode("manual"); // e.g. /provider re-resolves config and re-syncs the (same) mode
    let asked = false;
    const d = await eng.decide({ tool: "WebFetch", argsSummary: "{different}" }, (async () => { asked = true; return "deny"; }) as ApprovalCallback);
    expect(asked).toBe(false); // still remembered
    expect(d).toBe("allow");
    expect(eng.mode).toBe("manual");
  });
});

describe("permission engine — persisted grants (survive a relaunch)", () => {
  test("loads persisted grants at creation so a remembered tool never re-prompts", async () => {
    // Simulate a relaunch: FileWrite was allow-always'd in a prior session.
    const eng = createPermissionEngine("manual", { grants: { load: () => ["FileWrite"], persist: () => {} } });
    let asked = false;
    const d = await eng.decide({ tool: "FileWrite", argsSummary: "{}" }, (async () => { asked = true; return "deny"; }) as ApprovalCallback);
    expect(asked).toBe(false); // pre-approved from disk → no prompt
    expect(d).toBe("allow");
  });

  test("persist() is called when a NEW allow-always grant is made", async () => {
    const persisted: string[] = [];
    const eng = createPermissionEngine("manual", { grants: { load: () => [], persist: (t) => persisted.push(t) } });
    await eng.decide({ tool: "FileEdit", argsSummary: "{}" }, (async () => "allow-always") as ApprovalCallback);
    expect(persisted).toEqual(["FileEdit"]);
  });

  test("a one-time allow does NOT persist", async () => {
    const persisted: string[] = [];
    const eng = createPermissionEngine("manual", { grants: { load: () => [], persist: (t) => persisted.push(t) } });
    await eng.decide({ tool: "FileEdit", argsSummary: "{}" }, (async () => "allow") as ApprovalCallback);
    expect(persisted).toEqual([]);
  });
});
