// Compact a tool result for the REPL transcript. This is DISPLAY-ONLY — the
// model still receives the full tool output and the session log still records
// it; this just keeps the on-screen transcript from turning into a wall when a
// tool returns something big or single-line (e.g. minified JSON).
export function previewToolResult(output: string, maxLines = 8, maxLineLen = 160): string {
  const lines = output.split("\n");
  const head = lines
    .slice(0, maxLines)
    .map((l) => (l.length > maxLineLen ? l.slice(0, maxLineLen) + "…" : l));
  let out = head.join("\n");
  const moreLines = lines.length - maxLines;
  if (moreLines > 0) {
    out += `\n      … +${moreLines} more line${moreLines === 1 ? "" : "s"}`;
  } else if (out.length < output.length) {
    out += " …"; // a single long line was clipped
  }
  return out;
}
