// Stall watchdog (regression for the /ultraplan hour-long hang). A streaming
// provider's fetch carried only the user's abort signal and no timeout, so a
// silent socket sat in reader.read() forever. The watchdog aborts on IDLE — its
// signal fires if no chunk arrives within the window — while reset() keeps a
// healthy, actively-streaming response alive indefinitely.
import { test, expect, describe } from "bun:test";
import { createStallTimeout } from "../src/providers/stall-timeout";

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
