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

  test("strips C1 controls (U+0080–U+009F) but keeps printable Unicode/emoji", () => {
    const ST = String.fromCharCode(0x9c); // C1 String Terminator — could truncate the OSC
    const C1 = String.fromCharCode(0x80); // a C1 control
    // The accented letter and the emoji (both > U+009F) must survive untouched.
    expect(titleSequence(`a${ST}b${C1}c é 🚀`)).toBe(`${ESC}]0;abc é 🚀${BEL}`);
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

  // On Windows the OSC bytes get swallowed under Ink/ConPTY, so the title MUST
  // also go through SetConsoleTitle (process.title) — even when stdout is piped.
  test.if(process.platform === "win32")("sets process.title on Windows (bypasses the swallowed OSC)", () => {
    const prev = process.title;
    try {
      const out = { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream; // OSC skipped…
      setTerminalTitle("session-name", out);
      expect(process.title).toBe("session-name"); // …but the Windows tab still updates
    } finally {
      try { process.title = prev; } catch { /* ignore */ }
    }
  });
});
