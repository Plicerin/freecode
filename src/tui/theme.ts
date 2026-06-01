import chalk from "chalk";
import type { ThemeName } from "../config/schema";

export interface RGB { r: number; g: number; b: number; }

export const RGB = {
  assistant: { r: 215, g: 119, b: 87 } as RGB,
  permission: { r: 87, g: 105, b: 247 } as RGB,
  success: { r: 44, g: 122, b: 57 } as RGB,
  error: { r: 171, g: 43, b: 63 } as RGB,
  warning: { r: 150, g: 108, b: 30 } as RGB,
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
    base: isDark ? "#ffffff" : "#000000",
    dim: "#888888",
    border: "#666666",
    user: isDark ? "#22d3ee" : "#2563eb",
    tool: isDark ? "#d946ef" : "#a21caf",
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
