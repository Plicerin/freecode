import type { ChatRequest, Provider, StreamEvent, ToolCall } from "./types";
import { makeError } from "./friendly-errors";
import { sleep } from "../utils/ids";

const RESPONSES = [
  "I'll help with that. Let me think through it step by step.\n\n",
  "Here's a quick outline of what I'll do:\n\n1. Inspect the request\n2. Pick the right tools\n3. Run them and report back\n\n",
  "Acknowledged. Spawning a mock reasoning trace...\n\n",
  "Stub provider active — wire a real API key to stream real responses.\n\n",
];

export class MockProvider implements Provider {
  name = "Mock";
  id = "mock";

  models() {
    return ["mock-1", "mock-2", "mock-fast"];
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!req.model) {
      throw makeError("mock", "model required", "invalid_request");
    }
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const isFirstTurn = req.messages.filter((m) => m.role === "assistant").length === 0;
    const pickIdx = (lastUser?.content.length ?? 0) % RESPONSES.length;
    const text = RESPONSES[pickIdx] ?? RESPONSES[0]!;

    let buffer = "";
    for (const ch of text) {
      buffer += ch;
      yield { type: "text_delta", delta: ch };
      await sleep(8);
    }

    // One-shot demo tool call on the first turn if the prompt mentions
    // listing files. Subsequent turns just acknowledge and end.
    if (isFirstTurn && (lastUser?.content.toLowerCase().includes("list") || lastUser?.content.toLowerCase().includes("files"))) {
      const call: ToolCall = { id: "call-mock-1", name: "Glob", arguments: { pattern: "**/*.ts" } };
      yield { type: "tool_call", call };
    } else {
      yield { type: "text_delta", delta: "(mock: no further action — wire a real API key to continue)\n" };
    }

    yield {
      type: "usage",
      usage: { input: 120, output: buffer.length, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    };
    yield { type: "end", reason: "end_turn" };
  }
}
