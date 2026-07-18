// Bounded parallelism (Tier R — caps sub-agent fan-out). Pins the two properties
// that matter: never more than `limit` running at once, and results stay in input
// order regardless of completion order.
import { test, expect, describe } from "bun:test";
import { mapWithConcurrency } from "../src/utils/concurrency";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  test("never exceeds the limit and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(15);
      active--;
      return x * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]); // ordered
    expect(peak).toBe(3); // reached, never exceeded the cap
  });

  test("limit 1 runs strictly serially", async () => {
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 1, async (x) => {
      active++; peak = Math.max(peak, active);
      await sleep(5);
      order.push(x); active--;
      return x;
    });
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  test("handles empty input and a limit larger than the item count", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    let peak = 0, active = 0;
    const out = await mapWithConcurrency([1, 2], 10, async (x) => {
      active++; peak = Math.max(peak, active); await sleep(5); active--; return x;
    });
    expect(out).toEqual([1, 2]);
    expect(peak).toBe(2); // can't exceed the number of items
  });
});
