// End-to-end: a model that rejects >1 image per request should NOT dead-end.
// The loop must learn the limit from the 400, cap to the most-recent image, and
// retry — turning a fatal provider error into a recovered turn.
import { test, expect, describe } from "bun:test";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import type { Provider, ChatRequest, StreamEvent, ImagePart } from "../src/providers/types";

const img = (id: string): ImagePart => ({ mediaType: "image/png", data: `d-${id}` } as unknown as ImagePart);

// 400s whenever a request carries more than one image (kimi-style); otherwise OK.
class OneImageProvider implements Provider {
  id = "mock"; name = "one-image"; calls = 0; maxImagesSeen = 0;
  models() { return ["m"]; }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls += 1;
    const imgs = req.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    this.maxImagesSeen = Math.max(this.maxImagesSeen, imgs);
    if (imgs > 1) throw new Error("Model 'moonshotai/kimi-k2.6' supports at most 1 image per prompt.");
    yield { type: "text_delta", delta: "I can see the image." };
    yield { type: "end", reason: "end_turn" };
  }
}

const perm = createPermissionEngine("bypass");

describe("loop recovers from a per-request image limit", () => {
  test("caps to the limit and retries instead of failing the turn", async () => {
    const provider = new OneImageProvider();
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      provider, tools: [], model: "m", maxTurns: 3,
      prompt: "describe these sprites",
      images: [img("warrior"), img("sheet")], // two images → first request 400s
      permission: perm, promptUser: (async () => "allow") as ApprovalCallback,
      onEvent: (e) => events.push(e),
    });

    // It retried (two stream attempts: the 400, then the capped retry)…
    expect(provider.calls).toBe(2);
    // …and the second request was within the model's 1-image limit.
    expect(provider.maxImagesSeen).toBe(2); // the FIRST attempt had 2
    // The turn completed with real text, not a fatal error.
    expect(result.messages.some((m) => m.role === "assistant" && /see the image/i.test(m.content ?? ""))).toBe(true);
    // A legible note was surfaced, and no raw image-limit error leaked.
    expect(events.some((e) => e.type === "compacted" && /image\(s\) per request/i.test(e.text ?? ""))).toBe(true);
    expect(events.some((e) => e.type === "error" && /at most .* image/i.test(e.error ?? ""))).toBe(false);
  });
});

// A NO-VISION model (DeepSeek) rejects image content outright, not a count limit.
class NoVisionProvider implements Provider {
  id = "mock"; name = "no-vision"; calls = 0;
  models() { return ["m"]; }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls += 1;
    const imgs = req.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    if (imgs > 0) throw new Error('400 {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[3]: unknown variant `image_url`, expected `text`","type":"invalid_request_error"}}');
    yield { type: "text_delta", delta: "No vision here, but I read the note." };
    yield { type: "end", reason: "end_turn" };
  }
}

describe("loop recovers from a no-vision model rejecting images", () => {
  test("strips ALL images, retries, and clears them from the context so they can't re-poison", async () => {
    const provider = new NoVisionProvider();
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      provider, tools: [], model: "deepseek", maxTurns: 3,
      prompt: "look at this screenshot",
      images: [img("cockpit")], // any image → the request 400s on a no-vision model
      permission: perm, promptUser: (async () => "allow") as ApprovalCallback,
      onEvent: (e) => events.push(e),
    });

    expect(provider.calls).toBe(2); // 400, then the image-stripped retry
    expect(result.messages.some((m) => (m.images?.length ?? 0) > 0)).toBe(false); // no images left in context
    expect(result.messages.some((m) => m.role === "assistant" && /read the note/i.test(m.content ?? ""))).toBe(true);
    // A clear "no vision" note surfaced; no raw deserialize error leaked as fatal.
    expect(events.some((e) => e.type === "compacted" && /no vision/i.test(e.text ?? ""))).toBe(true);
    expect(events.some((e) => e.type === "error" && /image_url/i.test(e.error ?? ""))).toBe(false);
  });
});
