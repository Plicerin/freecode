// Pure paste logic: detect a multi-line paste, collapse it to a chip, expand the
// chip back to the real content at submit. (The keystroke wiring is verified live
// — the harness can't drive a terminal paste.)
import { test, expect, describe } from "bun:test";
import { stripPasteMarkers, isMultilinePaste, pastePlaceholder, expandPastes, countLines } from "../src/tui/paste";

const ESC = String.fromCharCode(27);
const wrap = (s: string) => `${ESC}[200~${s}${ESC}[201~`;

describe("stripPasteMarkers", () => {
  test("removes bracketed markers and flags their presence", () => {
    const r = stripPasteMarkers(wrap("hello\nworld"));
    expect(r.content).toBe("hello\nworld");
    expect(r.marked).toBe(true);
  });
  test("plain text is unchanged and unmarked", () => {
    expect(stripPasteMarkers("abc")).toEqual({ content: "abc", marked: false });
  });
});

describe("isMultilinePaste", () => {
  test("bracketed multi-line content is a paste", () => {
    expect(isMultilinePaste(wrap("a\nb\nc"))).toBe(true);
  });
  test("an unmarked multi-char chunk with a newline is a paste", () => {
    expect(isMultilinePaste("line1\nline2")).toBe(true);
  });
  test("a single keystroke or a lone Enter is NOT a paste", () => {
    expect(isMultilinePaste("a")).toBe(false);
    expect(isMultilinePaste("\r")).toBe(false);
    expect(isMultilinePaste("\n")).toBe(false); // lone newline = Enter, length 1
  });
  test("a single-line paste is not collapsed (no newline)", () => {
    expect(isMultilinePaste(wrap("just one long line of pasted text"))).toBe(false);
  });
});

describe("placeholder + expand round-trip", () => {
  test("chip shows the line count, expand restores the exact content", () => {
    const content = "first\nsecond\nthird";
    expect(countLines(content)).toBe(3);
    const chip = pastePlaceholder(1, content);
    expect(chip).toBe("[#1 +3 lines]");

    const map = new Map([[1, content]]);
    // The user typed around the chip; expand only touches the chip.
    expect(expandPastes(`look at this: ${chip} please`, map)).toBe(`look at this: ${content} please`);
  });

  test("multiple chips expand independently", () => {
    const map = new Map([[1, "a\nb"], [2, "x\ny\nz"]]);
    expect(expandPastes("[#1 +2 lines] and [#2 +3 lines]", map)).toBe("a\nb and x\ny\nz");
  });

  test("an unknown / deleted chip is left as literal text", () => {
    expect(expandPastes("[#9 +4 lines]", new Map())).toBe("[#9 +4 lines]");
  });
});
