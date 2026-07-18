// Slash-command autocomplete logic (keystroke/render wiring is verified live).
import { test, expect, describe } from "bun:test";
import { matchCommands, resolveSubmit } from "../src/tui/slash-complete";

const NAMES = ["/model", "/models", "/commit", "/commit-push-pr", "/compact", "/agents", "/skills"];

describe("matchCommands", () => {
  test("prefix-matches command names while typing a command", () => {
    expect(matchCommands("/com", NAMES)).toEqual(["/commit", "/commit-push-pr", "/compact"]);
    expect(matchCommands("/age", NAMES)).toEqual(["/agents"]);
  });
  test("no menu once a space is typed (now entering arguments)", () => {
    expect(matchCommands("/commit ", NAMES)).toEqual([]);
    expect(matchCommands("/commit my message", NAMES)).toEqual([]);
  });
  test("no menu for plain text (not a command)", () => {
    expect(matchCommands("hello", NAMES)).toEqual([]);
  });
  test("respects the display cap", () => {
    expect(matchCommands("/", NAMES, 3)).toHaveLength(3);
  });
});

describe("resolveSubmit — Enter runs the highlighted command", () => {
  test("completes a partial to the highlighted match", () => {
    const m = matchCommands("/age", NAMES);
    expect(resolveSubmit("/age", m, 0)).toBe("/agents");
  });
  test("honors the highlighted index (arrowed-down selection)", () => {
    const m = matchCommands("/com", NAMES); // [/commit, /commit-push-pr, /compact]
    expect(resolveSubmit("/com", m, 1)).toBe("/commit-push-pr");
  });
  test("clamps an out-of-range index", () => {
    const m = matchCommands("/com", NAMES);
    expect(resolveSubmit("/com", m, 99)).toBe("/compact");
  });
  test("leaves input untouched when there's a space (args being typed)", () => {
    expect(resolveSubmit("/model gpt-4o", [], 0)).toBe("/model gpt-4o");
  });
  test("leaves plain text untouched", () => {
    expect(resolveSubmit("fix the bug", [], 0)).toBe("fix the bug");
  });
  test("bare '/' is not auto-resolved (too ambiguous)", () => {
    expect(resolveSubmit("/", matchCommands("/", NAMES), 0)).toBe("/");
  });
});
