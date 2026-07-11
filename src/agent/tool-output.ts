import { nonTextRatio } from "./degeneration";

// FileRead refuses to return a binary file, but a shell command can pipe raw
// bytes straight back — `cat`, `type`, `Get-Content`, or a `node -e
// "readFileSync(pdf)"` that routes around FileRead's guard. Those bytes decode
// to U+FFFD garbage, and once that lands in the model's context the model
// degenerates into emitting replacement-char noise it can't recover from (a real
// incident: reading a PDF as text collapsed a session into "0�0�0").
// So guard tool output the same way FileRead guards a file: if it looks binary,
// swap the bytes for a short, actionable note before they reach the model.

/** If `output` looks like binary decoded as text, replace it with a note; else
 *  return it unchanged. */
export function guardBinaryToolOutput(output: string): { text: string; suppressed: boolean } {
  // Short outputs can't poison much and a stray control char in a tiny string is
  // noise; ANSI-coloured logs score ~0 (ESC is excluded from the ratio).
  if (output.length < 16 || nonTextRatio(output) < 0.12) return { text: output, suppressed: false };
  const bytes = Buffer.byteLength(output, "utf8");
  const preview = output.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const note =
    `[freecode suppressed ~${bytes} bytes of binary / non-text output. Reading raw binary ` +
    `(a PDF, image, executable, or compiled ROM) into the context corrupts the model. Extract it ` +
    `with a real tool instead — for a PDF, a text/parse library; to inspect bytes, print a bounded hex dump.` +
    (preview ? ` First printable chars: "${preview}".` : "") +
    `]`;
  return { text: note, suppressed: true };
}
