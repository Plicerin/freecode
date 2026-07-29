// Central UI icon set. One place to define every glyph so they stay consistent
// and can be swapped/recolored — before this they were scattered string-literals.
//
// A terminal can only draw glyphs present in the user's monospace font, so we ship
// THREE renderings per icon and pick one at startup:
//   - "nerd"    Nerd-Font glyphs (Font Awesome codepoints in the U+F0xx Private Use
//               Area — the most stable across Nerd-Font versions; visually the
//               Material/FA icon set). Requires the terminal to use a Nerd Font.
//   - "unicode" elegant STANDARD Unicode that renders in any modern terminal font
//               (the safe default — Google Material can't be embedded in a TTY).
//   - "ascii"   plain ASCII, for a no-Unicode terminal.
//
// Coloring is applied at the RENDER site (Ink <Text color=…>), not here — brand /
// neutral markers get theme.hex.assistant ("freecode blue", the owl's azure);
// status icons (ok/fail/warn) keep their semantic color so color still means
// something. This module only decides the GLYPH.

export type IconMode = "nerd" | "unicode" | "ascii";

export type IconName =
  | "assistant" | "tool" | "toolCall" | "subAgent" | "prompt" | "thinking"
  | "user" | "ok" | "fail" | "warn" | "bolt" | "goal" | "stop" | "search"
  | "update" | "sparkle" | "globe" | "eye" | "bullet" | "ready" | "memory";

// Nerd column as Font-Awesome CODEPOINTS (built at runtime so this source stays
// pure ASCII — no Private-Use glyphs to get mangled by an editor). These U+F0xx
// values are the long-stable FA set every Nerd Font ships.
const NERD_CP: Record<IconName, number> = {
  assistant: 0xf111, // circle
  tool:      0xf013, // cog
  toolCall:  0xf061, // arrow-right
  subAgent:  0xf149, // level-down
  prompt:    0xf054, // chevron-right
  thinking:  0xf075, // comment
  user:      0xf007, // user
  ok:        0xf00c, // check
  fail:      0xf00d, // times
  warn:      0xf071, // exclamation-triangle
  bolt:      0xf0e7, // bolt
  goal:      0xf140, // bullseye
  stop:      0xf04d, // stop
  search:    0xf002, // search
  update:    0xf062, // arrow-up
  sparkle:   0xf005, // star
  globe:     0xf0ac, // globe
  eye:       0xf06e, // eye
  bullet:    0xf111, // circle
  ready:     0xf111, // circle
  memory:    0xf1c0, // database (persistent recall store)
};

// [unicode, ascii]. Unicode is the elegant, font-independent default; the trailing
// comment shows the glyph. Emoji are written as \u{...} to keep the source ASCII.
const GLYPH: Record<IconName, readonly [string, string]> = {
  assistant: ["●", "*"], // ●  assistant reply marker
  tool:      ["⚙", "#"], // ⚙  a tool call/result
  toolCall:  ["→", ">"], // →  the live "call name(args)" line
  subAgent:  ["↳", ">"], // ↳  a sub-agent's interior step
  prompt:    ["❯", ">"], // ❯  selection caret in pickers
  thinking:  ["\u{1F4AD}", "~"], // 💭  reasoning bubble
  user:      ["\u{1F9D1}", "@"], // 🧑  your prompt marker
  ok:        ["✔", "+"], // ✔  pass / verified (kept green)
  fail:      ["✘", "x"], // ✘  fail (kept red)
  warn:      ["⚠", "!"], // ⚠  caution (kept amber)
  bolt:      ["⚡", "!"], // ⚡  generation speed
  goal:      ["◆", "*"], // ◆  /goal cycle
  stop:      ["⏹", "#"], // ⏹  interrupted
  search:    ["⌕", "?"], // ⌕  search
  update:    ["↑", "^"], // ↑  update available
  sparkle:   ["✦", "*"], // ✦  banner flourish
  globe:     ["\u{1F310}", "@"], // 🌐  web / fetch
  eye:       ["\u{1F9D0}", "o"], // 🧐  supervisor / consult
  bullet:    ["·", "."], // ·  system-note bullet
  ready:     ["●", "*"], // ●  ready dot (kept green)
  memory:    ["\u{1F9E0}", "*"], // 🧠  persistent-memory recall (Honcho)
};

// Elegant spinner (waxing/waning "moon") — font-independent, so it's shared by
// nerd + unicode; ascii falls back to a plain rotating bar.
const SPINNER: Record<IconMode, readonly string[]> = {
  unicode: ["◐", "◓", "◑", "◒"], // ◐ ◓ ◑ ◒
  nerd:    ["◐", "◓", "◑", "◒"],
  ascii:   ["-", "\\", "|", "/"],
};

/** Decide the icon mode. FREECODE_ICONS=nerd|unicode|ascii forces it; otherwise
 *  auto → ascii when the locale/term looks non-UTF-8, else the safe unicode set.
 *  Nerd is opt-in (a Nerd Font can't be reliably detected from a TTY). */
export function resolveIconMode(env: (k: string) => string | undefined = (k) => process.env[k]): IconMode {
  const forced = (env("FREECODE_ICONS") || "").trim().toLowerCase();
  if (forced === "nerd" || forced === "unicode" || forced === "ascii") return forced;
  const term = (env("TERM") || "").toLowerCase();
  const locale = `${env("LC_ALL") || ""}${env("LC_CTYPE") || ""}${env("LANG") || ""}`.toLowerCase();
  const noUnicode = term === "dumb" || term === "linux" || (locale !== "" && !/utf-?8/.test(locale));
  return noUnicode ? "ascii" : "unicode";
}

/** Build the glyph map for a mode. */
export function makeIcons(mode: IconMode): Record<IconName, string> {
  const out = {} as Record<IconName, string>;
  for (const k of Object.keys(GLYPH) as IconName[]) {
    out[k] = mode === "nerd" ? String.fromCodePoint(NERD_CP[k]) : mode === "unicode" ? GLYPH[k][0] : GLYPH[k][1];
  }
  return out;
}

/** The active mode + glyph set, resolved once at import. */
export const ICON_MODE: IconMode = resolveIconMode();
export const ICON: Record<IconName, string> = makeIcons(ICON_MODE);
export const SPINNER_FRAMES: readonly string[] = SPINNER[ICON_MODE];

export function spinnerFrames(mode: IconMode = ICON_MODE): readonly string[] {
  return SPINNER[mode];
}
