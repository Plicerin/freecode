// Stall watchdog (regression for the /ultraplan hour-long hang). A streaming
// provider's fetch carried only the user's abort signal and no timeout, so a
// silent socket sat in reader.read() forever. The watchdog aborts on IDLE — its
// signal fires if no chunk arrives within the window — while reset() keeps a
// healthy, actively-streaming response alive indefinitely.
import { test, expect, describe } from "bun:test";
import { createStallTimeout, streamFirstByteMs, streamIdleMs } from "../src/providers/stall-timeout";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createStallTimeout", () => {
  test("fires when the stream goes idle past the window", async () => {
    const w = createStallTimeout(undefined, 30);
    expect(w.signal.aborted).toBe(false);
    await sleep(60);
    expect(w.timedOut()).toBe(true);
    expect(w.signal.aborted).toBe(true);
    w.clear();
  });

  test("reset() keeps a steadily-streaming response alive past the window", async () => {
    const w = createStallTimeout(undefined, 40);
    // Simulate chunks arriving every 20ms for ~100ms — never idle long enough.
    for (let i = 0; i < 5; i++) {
      await sleep(20);
      w.reset();
    }
    expect(w.timedOut()).toBe(false);
    expect(w.signal.aborted).toBe(false);
    w.clear();
  });

  test("a user abort propagates to the signal but is NOT a timeout", async () => {
    const user = new AbortController();
    const w = createStallTimeout(user.signal, 10_000);
    user.abort();
    expect(w.signal.aborted).toBe(true);
    expect(w.timedOut()).toBe(false); // distinguishes cancel from stall
    w.clear();
  });

  test("an already-aborted user signal aborts immediately", () => {
    const user = new AbortController();
    user.abort();
    const w = createStallTimeout(user.signal, 10_000);
    expect(w.signal.aborted).toBe(true);
    expect(w.timedOut()).toBe(false);
    w.clear();
  });

  test("clear() stops the watchdog — no late abort", async () => {
    const w = createStallTimeout(undefined, 20);
    w.clear();
    await sleep(50);
    expect(w.timedOut()).toBe(false);
    expect(w.signal.aborted).toBe(false);
  });
});

describe("first-byte ceiling (dead-model fast-fail)", () => {
  test("config: 60s first-byte / 120s idle by default, env-overridable", () => {
    const prev = process.env.FREECODE_STREAM_FIRST_BYTE_MS;
    try {
      delete process.env.FREECODE_STREAM_FIRST_BYTE_MS;
      expect(streamFirstByteMs()).toBe(60_000);
      expect(streamIdleMs()).toBe(120_000);
      process.env.FREECODE_STREAM_FIRST_BYTE_MS = "5000";
      expect(streamFirstByteMs()).toBe(5000);
    } finally {
      if (prev === undefined) delete process.env.FREECODE_STREAM_FIRST_BYTE_MS;
      else process.env.FREECODE_STREAM_FIRST_BYTE_MS = prev;
    }
  });

  test("a LOCAL provider gets a roomier first-byte ceiling than cloud (cold model load)", () => {
    const prev = process.env.FREECODE_STREAM_FIRST_BYTE_MS;
    try {
      delete process.env.FREECODE_STREAM_FIRST_BYTE_MS;
      expect(streamFirstByteMs(true)).toBe(120_000);  // local: room to reload a multi-GB model
      expect(streamFirstByteMs(false)).toBe(60_000);  // cloud first-bytes in <1s
      process.env.FREECODE_STREAM_FIRST_BYTE_MS = "5000";
      expect(streamFirstByteMs(true)).toBe(5000);     // explicit override wins for both
      expect(streamFirstByteMs(false)).toBe(5000);
    } finally {
      if (prev === undefined) delete process.env.FREECODE_STREAM_FIRST_BYTE_MS;
      else process.env.FREECODE_STREAM_FIRST_BYTE_MS = prev;
    }
  });

  test("aborts at the SHORT first-byte ceiling when nothing ever streams", async () => {
    const w = createStallTimeout(undefined, 10_000 /* idle */, 50 /* firstByte */);
    await sleep(110);
    expect(w.timedOut()).toBe(true); // fired on first-byte, not the 10s idle
    w.clear();
  });

  test("once the first chunk arrives, the longer idle ceiling applies", async () => {
    const w = createStallTimeout(undefined, 300 /* idle */, 50 /* firstByte */);
    await sleep(30);
    w.reset(); // first byte before the 50ms first-byte ceiling
    await sleep(120); // past firstByte(50), under idle(300)
    expect(w.timedOut()).toBe(false);
    w.clear();
  });
});
