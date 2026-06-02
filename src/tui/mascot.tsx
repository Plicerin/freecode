import React from "react";
import { Box, Text } from "ink";
import type { makeTheme } from "./theme";

type Theme = ReturnType<typeof makeTheme>;

// The freecode owl — verification-first identity made flesh: big watchful
// eyes that check before they blink "done". Drawn in block shading so the
// silhouette reads at any color depth. The solid `█` glyph appears ONLY in
// the pupils, so we can light the eyes in bright azure while the body shades
// from slate to deep blue-grey.
export const OWL: string[] = [
  "░░▓▓░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░▓▓░░",
  "░░▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▓▓░░",
  "░░▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▓░░",
  "░░░░▓▓▒▒▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▒▒▓▓░░░░",
  "░░░░▓▓▓▓        ▓▓▒▒▒▒▒▒▓▓        ▓▓▓▓░░░░",
  "░░░░▓▓    ████    ▓▓▒▒▓▓    ████    ▓▓░░░░",
  "░░░░▓▓  ████  ██  ▓▓▒▒▓▓  ████  ██  ▓▓░░░░",
  "░░░░▓▓  ████████  ▓▓▒▒▓▓  ████████  ▓▓░░░░",
  "░░░░▓▓    ████    ▓▓▓▓▓▓    ████    ▓▓░░░░",
  "░░░░░░▓▓        ▓▓      ▓▓        ▓▓░░░░░░",
  "░░░░▓▓▒▒▓▓▓▓▓▓▓▓▒▒▓▓  ▓▓▒▒▓▓▓▓▓▓▓▓▒▒▓▓░░░░",
  "░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▒▒▒▒▓▓▒▒▒▒▒▒▒▒▓▓░░░░",
  "░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▒▒▒▒▒▒▒▒▒▒▓▓░░",
  "░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▒▒▒▒▒▒▒▒▒▒▓▓░░",
  "░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▒▒▒▒▒▒▒▒▒▒▒▒▓▓",
  "░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▒▒▒▒▒▒▒▒▒▒▓▓",
  "░░░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▒▒▒▒▒▒▒▒▒▒▓▓",
  "░░░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▒▒▒▒▒▒▒▒▓▓",
  "░░░░░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▒▒▒▒▒▒▓▓",
  "░░░░░░░░░░▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▓▒▒▓▓",
  "░░░░░░░░░░░░░░▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓░░",
  "░░░░░░░░░░░░▓▓░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▓▓░░",
  "░░░░░░░░░░░░▓▓▓▓▓▓▓▓░░░░░░▓▓░░░░▓▓▒▒▒▒▓▓░░",
  "░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▓▓▓░░░░░░░░▓▓▒▒▓▓░░",
  "▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░▓▓░░░░",
  "░░▒▒▒▒▒▒░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░",
  "░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░",
  "░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒░░░░░░░░░░░░░░░░",
];

// Tiny owl for tight spots (prompt, status line, headless banner).
export const OWL_MICRO = "(◉‿◉)";

// Per-glyph palette. `█` is eyes only → bright azure. The body shades from
// brand azure outline (▓) through muted slate (▒) to a receding dim field (░).
function glyphColor(ch: string, theme: Theme): { color?: string; bold?: boolean } {
  switch (ch) {
    case "█":
      return { color: theme.isDark ? "#9ed0ff" : "#1d6fe0", bold: true }; // eyes — glow
    case "▓":
      return { color: theme.hex.assistant }; // outline / facial disc — brand azure
    case "▒":
      return { color: theme.isDark ? "#5f7194" : "#7c8aa6" }; // feathers — slate
    case "░":
      return { color: theme.isDark ? "#313a4e" : "#c3cdda" }; // background — recedes
    default:
      return {}; // spaces (eye-whites) — terminal default
  }
}

// Run-length encode each row so adjacent same-glyph runs share one <Text>.
function colorRow(line: string, theme: Theme): React.ReactElement[] {
  const segs: React.ReactElement[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    let j = i + 1;
    while (j < line.length && line[j] === ch) j++;
    const { color, bold } = glyphColor(ch, theme);
    segs.push(
      <Text key={i} color={color} bold={bold}>
        {line.slice(i, j)}
      </Text>,
    );
    i = j;
  }
  return segs;
}

export function Mascot({ theme }: { theme: Theme }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {OWL.map((row, i) => (
        <Text key={i}>{colorRow(row, theme)}</Text>
      ))}
    </Box>
  );
}
