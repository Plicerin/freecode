// A Provider decorator that throttles chat requests through a shared RateLimiter
// (MRM). Only stream() — the billable, rate-limited path — is gated; models() and
// countTokens() pass straight through.
import type { Provider, ChatRequest, StreamEvent } from "./types";
import type { RateLimiter } from "../agent/rate-limit";
import { debug } from "../utils/debug";

export class RateLimitedProvider implements Provider {
  readonly name: string;
  readonly id: string;

  constructor(private readonly inner: Provider, private readonly limiter: RateLimiter) {
    this.name = inner.name;
    this.id = inner.id;
  }

  models(): Promise<string[]> | string[] {
    return this.inner.models();
  }

  countTokens(req: ChatRequest): Promise<number> {
    return this.inner.countTokens ? this.inner.countTokens(req) : Promise.resolve(0);
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    await this.limiter.acquire();
    debug.log("rate-limited stream", { provider: this.id });
    yield* this.inner.stream(req);
  }
}
