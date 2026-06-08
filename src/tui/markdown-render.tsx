import React from "react";
import { Box, Text } from "ink";
import type { makeTheme } from "./theme";
import { parseBlocks, tokenize, parseInline, classifyLine, type Kind } from "./markdown";

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

// Prose with inline `code`, **bold**, and *italic* spans styled.
function renderInline(text: string, theme: Theme): React.ReactNode[] {
  return parseInline(text).map((s, i) => {
    switch (s.kind) {
      case "code": return <Text key={i} color={theme.user}>{s.text}</Text>;
      case "bold": return <Text key={i} bold>{s.text}</Text>;
      case "italic": return <Text key={i} italic>{s.text}</Text>;
      default: return <Text key={i}>{s.text}</Text>;
    }
  });
}

// A single prose line: heading (bold + brand), bullet/ordered list item (with a
// styled marker and indent), or plain text — all with inline formatting applied.
function ProseLine({ line, theme, lead }: { line: string; theme: Theme; lead?: React.ReactNode }): React.ReactElement {
  const p = classifyLine(line);
  const pad = "  ".repeat(p.indent);
  if (p.kind === "heading") {
    return <Text>{lead}<Text bold color={theme.hex.assistant}>{renderInline(p.content, theme)}</Text></Text>;
  }
  if (p.kind === "bullet") {
    return <Text>{lead}{pad}<Text color={theme.hex.assistant}>• </Text>{renderInline(p.content, theme)}</Text>;
  }
  if (p.kind === "ordered") {
    return <Text>{lead}{pad}<Text color={theme.hex.assistant}>{p.marker}. </Text>{renderInline(p.content, theme)}</Text>;
  }
  return <Text>{lead}{renderInline(p.content, theme)}</Text>;
}

/** Render an assistant message: fenced code blocks syntax-highlighted, and prose
 *  with headings, lists, **bold**, *italic*, and inline `code` formatted. */
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
        const lines = b.content.split("\n");
        return (
          <Box key={bi} flexDirection="column">
            {lines.map((ln, li) => (
              <ProseLine key={li} line={ln} theme={theme} lead={bi === 0 && li === 0 ? lead : null} />
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
