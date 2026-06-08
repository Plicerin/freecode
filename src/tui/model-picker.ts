// Pure helpers for the interactive /model picker. Kept out of the REPL so the
// list-building and scroll-window math are unit-testable (the keystroke wiring
// itself can only be verified live — the fake-TTY harness can't drive keys).

// Models that aren't chat completions — hidden from the picker to keep it useful,
// though `/model <name>` still accepts any of them.
const NON_CHAT = /embedding|whisper|\btts\b|text-to-speech|audio|dall-?e|imagen|\bimage\b|moderation|realtime|transcrib|babbage|davinci|\bsearch\b/i;

/** Split a raw model list into the chat models to show + how many were hidden.
 *  Falls back to showing everything if the filter would leave nothing. */
export function filterChatModels(all: string[]): { show: string[]; hidden: number } {
  const chat = all.filter((m) => !NON_CHAT.test(m));
  const show = chat.length ? chat : all;
  return { show, hidden: all.length - show.length };
}

/** Filter a model list by a search query: case-insensitive, AND across
 *  whitespace-separated terms (so "claude opus" matches "claude-opus-4-8").
 *  Empty query → the list unchanged. */
export function searchModels(models: string[], query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return models;
  return models.filter((m) => {
    const lower = m.toLowerCase();
    return terms.every((t) => lower.includes(t));
  });
}

/** The visible slice of a (possibly long, e.g. OpenRouter's 300+) list for a
 *  scrolling picker: centers the cursor and clamps to the ends. `offset` is the
 *  index of the first visible item, for "↑ N more / ↓ N more" hints. */
export function pickerWindow<T>(items: T[], idx: number, height: number): { slice: T[]; offset: number } {
  if (height <= 0 || items.length <= height) return { slice: items, offset: 0 };
  let offset = idx - Math.floor(height / 2);
  offset = Math.max(0, Math.min(offset, items.length - height));
  return { slice: items.slice(offset, offset + height), offset };
}
