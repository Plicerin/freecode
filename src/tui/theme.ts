import chalk from "chalk";
import type { ThemeName } from "../config/schema";

export interface RGB { r: number; g: number; b: number; }

// freecode palette — one cool family (blues/greys); warm tones are reserved
// strictly for status, so warmth in the UI always means something.
export const RGB = {
  assistant: { r: 91, g: 156, b: 246 } as RGB, // azure — brand / assistant
  permission: { r: 111, g: 143, b: 232 } as RGB, // periwinkle
  success: { r: 63, g: 182, b: 143 } as RGB, // teal — verified / pass
  error: { r: 236, g: 106, b: 106 } as RGB, // coral — error
  warning: { r: 216, g: 162, b: 74 } as RGB, // amber — caution / unverified
} as const;

function hex(c: RGB): string {
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export const HEX = {
  assistant: hex(RGB.assistant),
  permission: hex(RGB.permission),
  success: hex(RGB.success),
  error: hex(RGB.error),
  warning: hex(RGB.warning),
};

export function makeTheme(name: ThemeName) {
  const isDark = name === "dark";
  return {
    name,
    isDark,
    base: isDark ? "#e6ebf4" : "#1f2a37",
    dim: isDark ? "#707c92" : "#64748b",
    border: isDark ? "#39435a" : "#c3cdda",
    user: isDark ? "#56c2d6" : "#0e8aa6",
    tool: isDark ? "#8895ad" : "#5b6b86",
    hex: HEX,
    chalk: {
      assistant: chalk.hex(HEX.assistant),
      permission: chalk.hex(HEX.permission),
      success: chalk.hex(HEX.success),
      error: chalk.hex(HEX.error),
      warning: chalk.hex(HEX.warning),
      dim: chalk.gray,
      base: isDark ? chalk.white : chalk.black,
    },
  };
}

export type Theme = ReturnType<typeof makeTheme>;
