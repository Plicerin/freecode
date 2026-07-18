// Pure logic behind the interactive /model picker (the keystroke wiring is
// verified live — the harness can't drive keys).
import { test, expect, describe } from "bun:test";
import { filterChatModels, orderChatModels, pickerWindow, searchModels, sortFreeFirst } from "../src/tui/model-picker";
import type { ModelInfo } from "../src/providers/types";

describe("sortFreeFirst", () => {
  test("floats free models to the top, stable within each group", () => {
    const models = ["gpt-4o", "meta/llama:free", "claude-opus", "qwen/q:free", "gemini"];
    expect(sortFreeFirst(models)).toEqual(["meta/llama:free", "qwen/q:free", "gpt-4o", "claude-opus", "gemini"]);
  });

  test("case-insensitive; no free models → unchanged", () => {
    expect(sortFreeFirst(["a-FREE-b", "c"])).toEqual(["a-FREE-b", "c"]);
    expect(sortFreeFirst(["x", "y"])).toEqual(["x", "y"]);
  });
});

describe("searchModels", () => {
  const models = ["gpt-4o", "gpt-5.4", "anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6", "gemini-2.5-pro"];

  test("empty query returns everything", () => {
    expect(searchModels(models, "")).toEqual(models);
    expect(searchModels(models, "   ")).toEqual(models);
  });

  test("case-insensitive substring match", () => {
    expect(searchModels(models, "GPT")).toEqual(["gpt-4o", "gpt-5.4"]);
    expect(searchModels(models, "sonnet")).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  test("ANDs across whitespace-separated terms", () => {
    expect(searchModels(models, "claude opus")).toEqual(["anthropic/claude-opus-4-8"]);
    expect(searchModels(models, "5 pro")).toEqual(["gemini-2.5-pro"]); // 2.5 has "5" and "pro"
  });

  test("no match → empty", () => {
    expect(searchModels(models, "llama")).toEqual([]);
  });
});

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

describe("orderChatModels (catalog-driven: availability + real free pricing)", () => {
  const infos: ModelInfo[] = [
    { id: "vendor/paid-chat", free: false, available: true, chat: true },
    { id: "vendor/free-chat", free: true, available: true, chat: true },
    { id: "vendor/free-music", free: true, available: true, chat: false }, // gen model — must be dropped
    { id: "vendor/expired-free", free: true, available: false, chat: true }, // withdrawn — must be dropped
    { id: "vendor/paid-chat-2", free: false, available: true, chat: true },
  ];

  test("drops unavailable + non-chat, floats truly-free chat models to the top", () => {
    expect(orderChatModels(infos)).toEqual(["vendor/free-chat", "vendor/paid-chat", "vendor/paid-chat-2"]);
  });

  test("free is by PRICING, not name — a paid model named ':free' is not floated (and a free one that isn't named 'free' is)", () => {
    const tricky: ModelInfo[] = [
      { id: "x/model:free", free: false, available: true, chat: true }, // no-longer-free despite the name
      { id: "y/actually-free", free: true, available: true, chat: true },
    ];
    expect(orderChatModels(tricky)).toEqual(["y/actually-free", "x/model:free"]);
  });

  test("falls back to the name heuristic when pricing/modality are unknown", () => {
    const unknown: ModelInfo[] = [
      { id: "a/plain" },
      { id: "b/thing:free" },
      { id: "c/whisper-1" }, // non-chat by name
    ];
    // b floated (name 'free'), whisper dropped (name heuristic), a kept
    expect(orderChatModels(unknown)).toEqual(["b/thing:free", "a/plain"]);
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
