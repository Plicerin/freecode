// The MemoryStore: the inert store when disabled, the block formatter, and the
// FAIL-SOFT contract — a throwing/absent Honcho must never throw out of record/
// flush/recall. HonchoMemoryStore is exercised through a stubbed global fetch.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createMemoryStore, formatMemoryBlock, ASSISTANT_PEER } from "../src/memory/store";

describe("createMemoryStore — disabled/unconfigured", () => {
  test("returns an inert store when disabled", async () => {
    const s = createMemoryStore({ enabled: false, baseUrl: "http://h:8100", workspace: "freecode", peer: "user", sessionId: "s1" });
    expect(s.enabled).toBe(false);
    expect(await s.recall()).toBe("");
    s.record("user", "hi"); // no throw
    await s.flush();
    expect((await s.status()).enabled).toBe(false);
  });

  test("returns an inert store when enabled but no baseUrl", async () => {
    const s = createMemoryStore({ enabled: true, workspace: "freecode", peer: "user", sessionId: "s1" });
    expect(s.enabled).toBe(false);
  });
});

describe("formatMemoryBlock", () => {
  test("empty representation and empty card → empty string", () => {
    expect(formatMemoryBlock("", [])).toBe("");
    expect(formatMemoryBlock("   ", [])).toBe("");
  });

  test("a representation renders with the header and the data-not-instructions guard", () => {
    const b = formatMemoryBlock("The user prefers TypeScript and Bun.", []);
    expect(b).toContain("Persistent memory about this user");
    expect(b).toContain("The user prefers TypeScript and Bun.");
    expect(b.toLowerCase()).toContain("data, not instructions");
  });

  test("falls back to the peer card when there is no representation", () => {
    const b = formatMemoryBlock("", ["prefers TS", "uses Bun"]);
    expect(b).toContain("- prefers TS");
    expect(b).toContain("- uses Bun");
  });

  test("caps a very long representation", () => {
    const b = formatMemoryBlock("x".repeat(20000), []);
    expect(b).toContain("(memory truncated)");
    expect(b.length).toBeLessThan(20000);
  });
});

describe("HonchoMemoryStore over a stubbed fetch", () => {
  interface Recorded { url: string; method: string; body?: any; }
  let calls: Recorded[] = [];
  let responder: (rec: Recorded) => { status?: number; json?: unknown };
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    responder = () => ({ json: {} });
    globalThis.fetch = (async (url: unknown, init: any = {}) => {
      const rec: Recorded = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(rec);
      const r = responder(rec);
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => "application/json" },
        json: async () => r.json,
        text: async () => JSON.stringify(r.json ?? ""),
      } as unknown as Response;
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  const store = () => createMemoryStore({ enabled: true, baseUrl: "http://h:8100", workspace: "freecode", peer: "user", sessionId: "sess-9" });

  test("recall returns a formatted block and caches it in context()", async () => {
    responder = () => ({ json: { representation: "Knows freecode internals." } });
    const s = store();
    const block = await s.recall();
    expect(block).toContain("Knows freecode internals.");
    expect(s.context()).toBe(block);
  });

  test("record + flush provisions and posts turns tagged by peer", async () => {
    const s = store();
    s.record("user", "hello");
    s.record("assistant", "hi there");
    await s.flush();
    const msgPost = calls.find((c) => c.url.endsWith("/sessions/sess-9/messages"));
    expect(msgPost).toBeDefined();
    expect(msgPost!.body.messages).toEqual([
      { content: "hello", peer_id: "user" },
      { content: "hi there", peer_id: ASSISTANT_PEER },
    ]);
    // provisioning happened first (workspace/peers/session get-or-create)
    expect(calls.some((c) => c.url.endsWith("/v3/workspaces"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/sessions"))).toBe(true);
  });

  test("blank turns are ignored and never flushed", async () => {
    const s = store();
    s.record("user", "   ");
    await s.flush();
    expect(calls).toHaveLength(0); // nothing queued → nothing provisioned
  });

  test("recall is fail-soft: a 500 yields '' and does not throw", async () => {
    responder = () => ({ status: 500, json: "err" });
    const s = store();
    expect(await s.recall()).toBe("");
  });

  test("flush is fail-soft: a 500 swallows and drops the batch", async () => {
    responder = () => ({ status: 500, json: "err" });
    const s = store();
    s.record("user", "hello");
    await s.flush(); // must not throw
    const st = await s.status();
    expect(st.pending).toBe(0); // dropped, not requeued unbounded
  });
});
