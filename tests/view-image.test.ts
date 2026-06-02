import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ViewImageTool } from "../src/tools/view-image";
import { runAgentLoop } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent, ChatMessage } from "../src/providers/types";
import type { Tool } from "../src/tools/types";

describe("ViewImage tool", () => {
  it("returns the image as base64", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-vi-"));
    const p = join(dir, "a.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const r = await ViewImageTool.run({ path: p }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.images?.[0]?.mediaType).toBe("image/png");
    expect(r.images?.[0]?.data.length).toBeGreaterThan(0);
  });
  it("rejects non-images", async () => {
    const r = await ViewImageTool.run({ path: "notes.txt" }, { cwd: process.cwd() });
    expect(r.ok).toBe(false);
  });
});

describe("agent loop feeds tool images back to the model", () => {
  it("feeds multiple tool images back without interleaving tool results", async () => {
    const seen: ChatMessage[][] = [];
    let turn = 0;
    const provider: Provider = {
      id: "mock", name: "cap", models: () => ["m"],
      async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
        seen.push(req.messages);
        if (turn++ === 0) {
          // Two tool calls in one turn — the case that 400'd against OpenAI.
          yield { type: "tool_call", call: { id: "c1", name: "FakeView", arguments: {} } };
          yield { type: "tool_call", call: { id: "c2", name: "FakeView", arguments: {} } };
          yield { type: "end", reason: "tool_use" };
        } else {
          yield { type: "text_delta", delta: "seen" };
          yield { type: "end", reason: "end_turn" };
        }
      },
    };
    const fakeView: Tool = {
      name: "FakeView", description: "x", schema: z.object({}), permission: "safe",
      async run() { return { ok: true, output: "loaded", images: [{ data: "QUJD", mediaType: "image/png" }] }; },
    };
    const perm = createPermissionEngine("bypass", (async () => "allow") as ApprovalCallback);
    await runAgentLoop({ provider, tools: [fakeView], model: "m", maxTurns: 3, prompt: "look", permission: perm, promptUser: (async () => "allow") as ApprovalCallback, onEvent: () => {} });

    const req = seen[1]!;
    const roles = req.map((m) => m.role);
    // No user message wedged between two tool results (the OpenAI 400 cause).
    for (let i = 1; i < roles.length - 1; i++) {
      if (roles[i] === "user") expect(!(roles[i - 1] === "tool" && roles[i + 1] === "tool")).toBe(true);
    }
    expect(req.filter((m) => m.role === "tool").length).toBe(2);
    expect(req.filter((m) => m.role === "user" && m.images?.length).length).toBe(1);
  });
});
