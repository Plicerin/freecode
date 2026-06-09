// Paste handling for the input box. A multi-line paste should NOT land as raw
// newlines (which the editor strips, or which fire a premature submit on the
// first \n) — instead it collapses to a chip like "[#1 +3 lines]", with the real
// content kept aside and substituted back in at submit time (Claude-Code style).
//
// We enable the terminal's BRACKETED PASTE mode so a paste arrives wrapped in
// ESC[200~ … ESC[201~ (one burst, distinguishable from typing). We also fall
// back to a plain newline heuristic in case a terminal delivers the content
// without the markers.

const ESC = String.fromCharCode(27);
export const BRACKET_PASTE_ON = `${ESC}[?2004h`;
export const BRACKET_PASTE_OFF = `${ESC}[?2004l`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Remove bracketed-paste markers from a chunk; report whether any were present. */
export function stripPasteMarkers(chunk: string): { content: string; marked: boolean } {
  const marked = chunk.includes(PASTE_START) || chunk.includes(PASTE_END);
  const content = chunk.split(PASTE_START).join("").split(PASTE_END).join("");
  return { content, marked };
}

/** True when a raw input chunk is a multi-line paste (worth collapsing to a
 *  chip), not a keystroke. Bracketed → any newline; unmarked → a multi-char
 *  chunk that contains a newline (a lone "\r" is just Enter). */
export function isMultilinePaste(chunk: string): boolean {
  const { content, marked } = stripPasteMarkers(chunk);
  if (!/\r|\n/.test(content)) return false;
  return marked || content.length > 1;
}

export function countLines(content: string): number {
  return content.split(/\r\n|\r|\n/).length;
}

/** The chip shown inline in the input for a collapsed paste. */
export function pastePlaceholder(id: number, content: string): string {
  return `[#${id} +${countLines(content)} lines]`;
}

const PLACEHOLDER_RE = /\[#(\d+) \+\d+ lines\]/g;

/** Substitute each chip back to its full content for the message actually sent.
 *  A chip whose paste is gone (user deleted it / unknown id) is left as-is. */
export function expandPastes(text: string, map: Map<number, string>): string {
  return text.replace(PLACEHOLDER_RE, (m, n: string) => {
    const v = map.get(Number(n));
    return v === undefined ? m : v;
  });
}
