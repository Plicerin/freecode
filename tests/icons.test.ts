// The central icon set: three renderings (nerd/unicode/ascii) + mode resolution.
// Locks the glyphs so a stray edit can't blank an icon, and the FontAwesome
// codepoints so the nerd set stays the stable U+F0xx range.
import { test, expect, describe } from "bun:test";
import { makeIcons, resolveIconMode, spinnerFrames, ICON, type IconName } from "../src/tui/icons";

const ALL: IconName[] = [
  "assistant", "tool", "toolCall", "subAgent", "prompt", "thinking", "user",
  "ok", "fail", "warn", "bolt", "goal", "stop", "search", "update", "sparkle",
  "globe", "eye", "bullet", "ready", "memory",
];

describe("makeIcons", () => {
  test("every icon is non-empty in all three modes", () => {
    for (const mode of ["nerd", "unicode", "ascii"] as const) {
      const I = makeIcons(mode);
      for (const k of ALL) {
        expect(I[k], `${mode}.${k}`).toBeTruthy();
        expect(I[k].length, `${mode}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  test("unicode glyphs are the expected elegant set", () => {
    const I = makeIcons("unicode");
    expect(I.assistant).toBe("●");
    expect(I.tool).toBe("⚙");
    expect(I.ok).toBe("✔");
    expect(I.fail).toBe("✘");
    expect(I.warn).toBe("⚠");
    expect(I.prompt).toBe("❯");
  });

  test("ascii is pure 7-bit", () => {
    const I = makeIcons("ascii");
    for (const k of ALL) {
      for (const ch of I[k]) expect(ch.codePointAt(0)!).toBeLessThan(128);
    }
  });

  test("nerd glyphs sit in the Font-Awesome PUA (U+F000–U+F2FF)", () => {
    const I = makeIcons("nerd");
    for (const k of ALL) {
      const cp = I[k].codePointAt(0)!;
      expect(cp, `nerd.${k}=U+${cp.toString(16)}`).toBeGreaterThanOrEqual(0xf000);
      expect(cp, `nerd.${k}=U+${cp.toString(16)}`).toBeLessThanOrEqual(0xf2ff);
    }
  });

  test("known FA codepoints are stable", () => {
    const I = makeIcons("nerd");
    expect(I.tool.codePointAt(0)).toBe(0xf013); // cog
    expect(I.ok.codePointAt(0)).toBe(0xf00c);   // check
    expect(I.fail.codePointAt(0)).toBe(0xf00d);  // times
    expect(I.warn.codePointAt(0)).toBe(0xf071);  // exclamation-triangle
  });
});

describe("resolveIconMode", () => {
  const env = (obj: Record<string, string>) => (k: string) => obj[k];
  test("FREECODE_ICONS forces the mode", () => {
    expect(resolveIconMode(env({ FREECODE_ICONS: "nerd" }))).toBe("nerd");
    expect(resolveIconMode(env({ FREECODE_ICONS: "ascii" }))).toBe("ascii");
    expect(resolveIconMode(env({ FREECODE_ICONS: "UNICODE" }))).toBe("unicode");
  });
  test("auto defaults to unicode, ascii only on a non-UTF-8 terminal", () => {
    expect(resolveIconMode(env({}))).toBe("unicode");
    expect(resolveIconMode(env({ LANG: "en_US.UTF-8" }))).toBe("unicode");
    expect(resolveIconMode(env({ TERM: "dumb" }))).toBe("ascii");
    expect(resolveIconMode(env({ LANG: "C" }))).toBe("ascii");
  });
  test("a bogus FREECODE_ICONS falls through to auto", () => {
    expect(resolveIconMode(env({ FREECODE_ICONS: "sparkles" }))).toBe("unicode");
  });
});

describe("spinner + exported ICON", () => {
  test("spinner has frames in each mode", () => {
    expect(spinnerFrames("unicode").length).toBeGreaterThan(1);
    expect(spinnerFrames("ascii").length).toBeGreaterThan(1);
  });
  test("the resolved ICON export is populated", () => {
    for (const k of ALL) expect(ICON[k]).toBeTruthy();
  });
});
