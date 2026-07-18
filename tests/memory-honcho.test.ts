// The Honcho v3 client: URL shapes, request bodies, Honcho's content/batch
// limits, and response parsing — all against a stubbed global fetch (no live
// server). The live round-trip was validated separately during development.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { HonchoClient } from "../src/memory/honcho";

interface Recorded { url: string; method: string; body?: any; headers: Record<string, string>; }
let calls: Recorded[] = [];
let responder: (rec: Recorded) => { status?: number; json?: unknown; ct?: string };
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  responder = () => ({ json: {} });
  globalThis.fetch = (async (url: unknown, init: any = {}) => {
    const rec: Recorded = {
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(rec);
    const r = responder(rec);
    const status = r.status ?? 200;
    const ct = r.ct ?? "application/json";
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? ct : null) },
      json: async () => r.json,
      text: async () => (typeof r.json === "string" ? r.json : JSON.stringify(r.json ?? "")),
    } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const mk = (apiKey?: string) => new HonchoClient({ baseUrl: "http://h:8100", workspace: "freecode", apiKey });

describe("provisioning (get-or-create)", () => {
  test("ensureWorkspace posts the freecode workspace", async () => {
    await mk().ensureWorkspace();
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://h:8100/v3/workspaces");
    expect(calls[0]!.body).toEqual({ id: "freecode", metadata: { app: "freecode" } });
  });

  test("ensurePeer / ensureSession hit the workspace-scoped routes", async () => {
    await mk().ensurePeer("user");
    expect(calls[0]!.url).toBe("http://h:8100/v3/workspaces/freecode/peers");
    expect(calls[0]!.body).toEqual({ id: "user" });

    calls = [];
    await mk().ensureSession("sess-1", ["user", "assistant"]);
    expect(calls[0]!.url).toBe("http://h:8100/v3/workspaces/freecode/sessions");
    expect(calls[0]!.body).toEqual({ id: "sess-1", peers: { user: {}, assistant: {} } });
  });
});

describe("addMessages", () => {
  test("posts a batch, dropping blank turns", async () => {
    await mk().addMessages("s1", [
      { content: "hello", peer_id: "user" },
      { content: "   ", peer_id: "user" }, // blank → dropped
      { content: "hi", peer_id: "assistant" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://h:8100/v3/workspaces/freecode/sessions/s1/messages");
    expect(calls[0]!.body.messages).toEqual([
      { content: "hello", peer_id: "user" },
      { content: "hi", peer_id: "assistant" },
    ]);
  });

  test("caps content to Honcho's 25k limit, keeping head and tail", async () => {
    const big = "A".repeat(20000) + "B".repeat(20000);
    await mk().addMessages("s1", [{ content: big, peer_id: "user" }]);
    const sent: string = calls[0]!.body.messages[0].content;
    expect(sent.length).toBeLessThanOrEqual(25000);
    expect(sent).toContain("[truncated]");
    expect(sent.startsWith("A")).toBe(true);
    expect(sent.endsWith("B")).toBe(true);
  });

  test("splits >100 messages into separate batches", async () => {
    const msgs = Array.from({ length: 150 }, (_, i) => ({ content: `m${i}`, peer_id: "user" }));
    await mk().addMessages("s1", msgs);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.messages).toHaveLength(100);
    expect(calls[1]!.body.messages).toHaveLength(50);
  });
});

describe("recall endpoints", () => {
  test("getRepresentation returns the representation string", async () => {
    responder = () => ({ json: { representation: "The user uses Bun." } });
    const rep = await mk().getRepresentation("user");
    expect(rep).toBe("The user uses Bun.");
    expect(calls[0]!.url).toBe("http://h:8100/v3/workspaces/freecode/peers/user/representation");
    expect(calls[0]!.body).toEqual({}); // no search_query unless asked
  });

  test("getRepresentation forwards a search_query when given", async () => {
    responder = () => ({ json: { representation: "x" } });
    await mk().getRepresentation("user", { searchQuery: "testing", searchTopK: 5 });
    expect(calls[0]!.body).toEqual({ search_query: "testing", search_top_k: 5 });
  });

  test("getRepresentation tolerates a missing field", async () => {
    responder = () => ({ json: {} });
    expect(await mk().getRepresentation("user")).toBe("");
  });

  test("getPeerCard returns the bullet array, [] when null", async () => {
    responder = () => ({ json: { peer_card: ["prefers TS", "uses Bun"] } });
    expect(await mk().getPeerCard("user")).toEqual(["prefers TS", "uses Bun"]);
    responder = () => ({ json: { peer_card: null } });
    expect(await mk().getPeerCard("user")).toEqual([]);
  });

  test("chat returns the dialectic content", async () => {
    responder = () => ({ json: { content: "They like concise answers." } });
    const a = await mk().chat("user", "what tone?");
    expect(a).toBe("They like concise answers.");
    expect(calls[0]!.body).toEqual({ query: "what tone?" });
  });
});

describe("transport", () => {
  test("throws on a non-2xx response, surfacing status + body", async () => {
    responder = () => ({ status: 500, json: "boom" });
    await expect(mk().ensureWorkspace()).rejects.toThrow(/500/);
  });

  test("sends a bearer token only when an apiKey is set", async () => {
    await mk("secret").ensureWorkspace();
    expect(calls[0]!.headers.authorization).toBe("Bearer secret");
    calls = [];
    await mk().ensureWorkspace();
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  test("ping is true on a healthy /health, false when it throws", async () => {
    responder = (rec) => (rec.url.endsWith("/health") ? { status: 200, json: {} } : { json: {} });
    expect(await mk().ping()).toBe(true);
    globalThis.fetch = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    expect(await mk().ping()).toBe(false);
  });
});
