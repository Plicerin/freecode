// Approval queue (regression for the /ultraplan "hang"). A workflow stage fans
// out to parallel sub-agents that can each request a tool approval at the same
// instant. The old single-resolver design let the second request clobber the
// first, orphaning its promise so the stage's Promise.all never resolved. These
// tests pin the queue's clobber-resistance: every concurrent request resolves.
import { test, expect, describe } from "bun:test";
import { createApprovalQueue } from "../src/tui/approval-queue";
import type { ApprovalRequest } from "../src/permissions/modes";

const req = (tool: string): ApprovalRequest => ({ tool, argsSummary: `${tool}(...)` });

describe("createApprovalQueue", () => {
  test("two concurrent requests both resolve — the second does not clobber the first", async () => {
    const heads: (string | null)[] = [];
    const q = createApprovalQueue((r) => heads.push(r?.tool ?? null));

    // Two sub-agents ask at once. Only the first shows; the second waits.
    const p1 = q.enqueue(req("Bash"));
    const p2 = q.enqueue(req("FileEdit"));
    expect(q.size()).toBe(2);
    expect(q.head()!.tool).toBe("Bash");

    // Answer the head → it resolves, and the queue advances to the second.
    expect(q.resolveHead("allow")!.tool).toBe("FileEdit");
    expect(await p1).toBe("allow");
    expect(q.head()!.tool).toBe("FileEdit");

    // Answer the second → it resolves too (the bug: this promise used to hang).
    q.resolveHead("deny");
    expect(await p2).toBe("deny");
    expect(q.size()).toBe(0);
    expect(q.head()).toBeNull();

    // onHeadChange saw: show Bash, advance to FileEdit, then clear.
    expect(heads).toEqual(["Bash", "FileEdit", null]);
  });

  test("flush denies every queued request at once and clears the head", async () => {
    const q = createApprovalQueue(() => {});
    const ps = [q.enqueue(req("Bash")), q.enqueue(req("WebSearch")), q.enqueue(req("FileWrite"))];
    expect(q.size()).toBe(3);

    q.flush(); // one esc → deny the whole fan-out
    expect(await Promise.all(ps)).toEqual(["deny", "deny", "deny"]);
    expect(q.size()).toBe(0);
    expect(q.head()).toBeNull();
  });

  test("resolving past the end is a safe no-op (returns null head)", () => {
    const q = createApprovalQueue(() => {});
    expect(q.resolveHead("allow")).toBeNull(); // empty queue
    expect(q.size()).toBe(0);
  });

  test("a fresh request after drain shows immediately", async () => {
    const heads: (string | null)[] = [];
    const q = createApprovalQueue((r) => heads.push(r?.tool ?? null));
    const p = q.enqueue(req("Bash"));
    q.resolveHead("allow");
    await p;
    const p2 = q.enqueue(req("Grep"));
    expect(q.head()!.tool).toBe("Grep"); // immediately the head, not stuck behind a stale one
    q.resolveHead("allow");
    await p2;
    expect(heads).toEqual(["Bash", null, "Grep", null]);
  });
});
