// Models sometimes collapse mid-stream into runaway repetition — a single
// character tiled thousands of times ("LLLLL…"), or a tiny set of tokens looped
// forever ("Vodafone Vodafone …"). Left unchecked the stream burns tokens (and
// the user's money) until they hit esc. This detector lets the REPL abort such a
// turn. The thresholds are deliberately conservative: they only trip on output
// that is unambiguously pathological, never on legitimate code, dividers, or
// repetitive-but-real prose.

interface CharRun {
  char: string;
  length: number;
}

function longestCharRun(s: string): CharRun {
  let best: CharRun = { char: "", length: 0 };
  let i = 0;
  while (i < s.length) {
    let j = i + 1;
    while (j < s.length && s[j] === s[i]) j++;
    if (j - i > best.length) best = { char: s[i]!, length: j - i };
    i = j;
  }
  return best;
}

/** If the text's tail looks degenerate, return a short reason; else null.
 *  Only judges once there's enough output for runaway repetition to be
 *  unambiguous (short, normal replies are never flagged). */
export function degenerationReason(text: string): string | null {
  if (text.length < 800) return null; // too early to tell
  const tail = text.slice(-2000);

  // 1) One character repeated in a very long unbroken run, ignoring whitespace
  //    (catches "LLL\nLLL\nLLL…" as well as a solid block). 200 is far beyond
  //    any legitimate divider, indent, or ASCII-art line.
  const run = longestCharRun(tail.replace(/\s+/g, ""));
  if (run.length >= 200) return `the character "${run.char}" repeated ${run.length}× in a row`;

  // 2) The window collapses to a handful of distinct tokens despite being long —
  //    the classic token loop. 80+ tokens with under 12% distinct is not prose.
  const tokens = tail.split(/\s+/).filter(Boolean);
  if (tokens.length >= 100) {
    const distinct = new Set(tokens).size;
    if (distinct / tokens.length < 0.1) return `${tokens.length} tokens but only ${distinct} distinct`;
  }

  return null;
}

export function isDegenerate(text: string): boolean {
  return degenerationReason(text) !== null;
}
