import type { ChatRequest, Provider, StreamEvent } from "./types";
import { makeError } from "./friendly-errors";

const HINTS: Record<string, string> = {
  bedrock: "AWS Bedrock support is not implemented yet (it needs SigV4 request signing). Use --provider anthropic, openai, gemini, or a local provider for now.",
  vertex: "Google Vertex AI support is not implemented yet (it needs Google service-account auth). Use --provider gemini for Google models, or another provider for now.",
};

/**
 * A provider that fails honestly instead of silently returning mock output.
 * Used for selectors that are advertised but not yet really wired up, so the
 * app never pretends to support a backend it doesn't.
 */
export class UnimplementedProvider implements Provider {
  readonly id: string;
  readonly name: string;

  constructor(id: string) {
    this.id = id;
    this.name = id;
  }

  models(): string[] {
    return [];
  }

  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    const hint = HINTS[this.id] ?? `Provider '${this.id}' is not implemented yet.`;
    yield { type: "error", error: makeError(this.id, hint, "not_implemented") };
  }
}
