import { test, expect, describe } from "bun:test";
import { tokensPerSecond, estTokens, formatSpeed } from "../src/tui/speed";

describe("tokensPerSecond", () => {
  test("tokens over seconds", () => {
    expect(tokensPerSecond(100, 1000)).toBe(100);
    expect(tokensPerSecond(50, 2000)).toBe(25);
  });
  test("guards zero/negative elapsed and zero tokens", () => {
    expect(tokensPerSecond(100, 0)).toBe(0);
    expect(tokensPerSecond(0, 1000)).toBe(0);
  });
});

describe("estTokens", () => {
  test("~4 chars per token", () => {
    expect(estTokens(400)).toBe(100);
    expect(estTokens(0)).toBe(0);
  });
});

describe("formatSpeed", () => {
  test("one decimal under 10, rounded above, blank when unknown", () => {
    expect(formatSpeed(46.4)).toBe("46 tok/s");
    expect(formatSpeed(5.53)).toBe("5.5 tok/s");
    expect(formatSpeed(0)).toBe("");
    expect(formatSpeed(NaN)).toBe("");
  });
});
