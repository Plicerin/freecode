import React from "react";
import { Box, Text } from "ink";
import type { makeTheme } from "./theme";
import { parseBlocks, tokenize, type Kind } from "./markdown";

type Theme = ReturnType<typeof makeTheme>;

function codeColor(kind: Kind, theme: Theme): string | undefined {
  switch (kind) {
    case "kw": return theme.hex.assistant; // keywords — brand azure
    case "str": return theme.hex.success; // strings — teal
    case "com": return theme.dim; // comments — dim
    case "num": return theme.hex.warning; // numbers — amber
    default: return undefined; // plain code — terminal default
  }
}

// Prose with inline `code` spans coloured.
function renderInline(text: string, theme: Theme): React.ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((p, i) =>
    p.length > 1 && p.startsWith("`") && p.endsWith("`")
      ? <Text key={i} color={theme.user}>{p.slice(1, -1)}</Text>
      : <Text key={i}>{p}</Text>,
  );
}

/** Render an assistant message with markdown code blocks syntax-highlighted and
 *  inline code coloured. Prose is rendered in the terminal default. */
export function MarkdownBody({ text, theme, marker }: { text: string; theme: Theme; marker?: React.ReactNode }): React.ReactElement {
  const blocks = parseBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, bi) => {
        const lead = bi === 0 ? marker : null;
        if (b.type === "code") {
          const toks = tokenize(b.content);
          return (
            <Box key={bi} flexDirection="column">
              {lead && <Text>{lead}</Text>}
              <Box marginLeft={2}>
                <Text>{toks.map((t, ti) => <Text key={ti} color={codeColor(t.kind, theme)}>{t.text}</Text>)}</Text>
              </Box>
            </Box>
          );
        }
        return <Text key={bi}>{lead}{renderInline(b.content, theme)}</Text>;
      })}
    </Box>
  );
}
