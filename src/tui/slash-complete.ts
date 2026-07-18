// Pure logic for slash-command autocomplete. The keystroke/render wiring can
// only be verified live (the fake-TTY harness can't drive keys), so the matching
// and the Enter-resolution rule live here where they can be unit-tested.

/** Command names matching the current input as a prefix — only while typing a
 *  command NAME (starts with "/", no space yet). Capped for display. */
export function matchCommands(input: string, names: string[], limit = 8): string[] {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  return names.filter((n) => n.startsWith(input)).slice(0, limit);
}

/** What Enter submits. When the suggestion menu is open on a partial command,
 *  Enter runs the HIGHLIGHTED match (palette-style completion, e.g. "/age" →
 *  "/agents"); otherwise it submits the raw input unchanged. */
export function resolveSubmit(input: string, matches: string[], menuIdx: number): string {
  if (matches.length > 0 && input.startsWith("/") && input.length > 1 && !input.includes(" ")) {
    const idx = Math.min(Math.max(0, menuIdx), matches.length - 1);
    return matches[idx] ?? input;
  }
  return input;
}
