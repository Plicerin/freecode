// Terminal tab title = the session name. Pins the OSC byte format and the
// sanitisation (a stray control char or runaway length can't corrupt the tab).
import { test, expect, describe } from "bun:test";
import { titleSequence, setTerminalTitle } from "../src/tui/terminal-title";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("titleSequence", () => {
  test("wraps the title in OSC 0 ... BEL", () => {
    expect(titleSequence("freecode · my-app")).toBe(`${ESC}]0;freecode · my-app${BEL}`);
  });

  test("strips control chars — including an embedded ESC/BEL that could break out", () => {
    expect(titleSequence(`a${BEL}b${ESC}c\n`)).toBe(`${ESC}]0;abc${BEL}`);
  });

  test("caps the title length", () => {
    const seq = titleSequence("x".repeat(200));
    expect(seq.length).toBeLessThanOrEqual(1 + 3 + 60 + 1); // ESC + ]0; + (<=60) + BEL
  });
});

describe("setTerminalTitle", () => {
  test("writes both OSC 2 and OSC 0 to a TTY", () => {
    let written = "";
    const out = { isTTY: true, write: (s: string) => { written = s; return true; } } as unknown as NodeJS.WriteStream;
    setTerminalTitle("hello", out);
    expect(written).toContain(`${ESC}]0;hello${BEL}`);
    expect(written).toContain(`${ESC}]2;hello${BEL}`);
  });

  test("writes nothing when stdout is not a TTY (piped output stays clean)", () => {
    let written = "";
    const out = { isTTY: false, write: (s: string) => { written = s; return true; } } as unknown as NodeJS.WriteStream;
    setTerminalTitle("hello", out);
    expect(written).toBe("");
  });
});
