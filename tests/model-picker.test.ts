// Pure logic behind the interactive /model picker (the keystroke wiring is
// verified live — the harness can't drive keys).
import { test, expect, describe } from "bun:test";
import { filterChatModels, pickerWindow } from "../src/tui/model-picker";

describe("filterChatModels", () => {
  test("hides non-chat models, keeps chat ones, counts hidden", () => {
    const all = ["gpt-4o", "text-embedding-3-large", "whisper-1", "anthropic/claude-3.7-sonnet", "dall-e-3"];
    const { show, hidden } = filterChatModels(all);
    expect(show).toEqual(["gpt-4o", "anthropic/claude-3.7-sonnet"]);
    expect(hidden).toBe(3);
  });
  test("falls back to showing everything if the filter would empty the list", () => {
    const all = ["text-embedding-3-small", "whisper-1"];
    const { show, hidden } = filterChatModels(all);
    expect(show).toEqual(all);
    expect(hidden).toBe(0);
  });
});

describe("pickerWindow", () => {
  const items = Array.from({ length: 50 }, (_, i) => `m${i}`);
  test("returns the whole list when it fits", () => {
    expect(pickerWindow(["a", "b", "c"], 1, 12)).toEqual({ slice: ["a", "b", "c"], offset: 0 });
  });
  test("centers the cursor in a long list", () => {
    const { slice, offset } = pickerWindow(items, 25, 10);
    expect(slice.length).toBe(10);
    expect(offset).toBe(20); // 25 - floor(10/2)
    expect(slice[5]).toBe("m25"); // cursor visible
  });
  test("clamps at the top", () => {
    expect(pickerWindow(items, 0, 10)).toEqual({ slice: items.slice(0, 10), offset: 0 });
  });
  test("clamps at the bottom", () => {
    const { offset, slice } = pickerWindow(items, 49, 10);
    expect(offset).toBe(40); // 50 - 10
    expect(slice[slice.length - 1]).toBe("m49");
  });
});
