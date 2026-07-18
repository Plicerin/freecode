// streamHealth classifies the in-flight turn from silence AND throughput. The
// case that motivated it: a stream trickling at 0.2 tok/s for minutes never trips
// the silence-based idle watchdog, yet is effectively stalled — it must read as
// "stalled" so the "Working…" line turns coral and the crawl warning fires.
import { test, expect, describe } from "bun:test";
import { streamHealth } from "../src/tui/speed";

describe("streamHealth", () => {
  test("flowing fast = healthy", () => {
    expect(streamHealth(0, 10_000, 40)).toBe("healthy");
    expect(streamHealth(1_000, 60_000, 25)).toBe("healthy");
  });

  test("silence escalates: <5s healthy, ≥5s slow, ≥20s stalled", () => {
    expect(streamHealth(4_000, 0, null)).toBe("healthy"); // still connecting, recent
    expect(streamHealth(8_000, 0, null)).toBe("slow");
    expect(streamHealth(25_000, 0, null)).toBe("stalled");
  });

  test("the reported bug: 0.2 tok/s for minutes reads as stalled, not busy", () => {
    expect(streamHealth(2_000, 90_000, 0.2)).toBe("stalled");
  });

  test("a brief slow patch is 'slow', not yet 'stalled'", () => {
    // 3 tok/s after 20s of a burst → slow band (≥15s & <5 tok/s), not stalled.
    expect(streamHealth(1_000, 20_000, 3)).toBe("slow");
  });

  test("low tok/s before the grace window does not count yet", () => {
    // 1 tok/s but only 10s in — under both burst grace windows, recent bytes → healthy.
    expect(streamHealth(500, 10_000, 1)).toBe("healthy");
  });

  test("null tps (not generating yet) is judged on silence alone", () => {
    expect(streamHealth(3_000, 0, null)).toBe("healthy");
    expect(streamHealth(30_000, 0, null)).toBe("stalled");
  });
});
