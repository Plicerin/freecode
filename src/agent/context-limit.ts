// Learn a model's REAL usable context size from a provider's context-overflow
// 400. This is the server's own ground truth — more reliable than llama.cpp's
// /props (its reported KV `n_ctx` can overstate the usable context) or a name-
// based guess, and it sidesteps our char/4 token estimate drifting from the
// server's real tokenizer. The agent loop uses it to self-heal: shrink the
// window, compact/trim to fit, and retry — instead of dead-ending on the 400.

/** The usable context size (tokens) named in a context-overflow error, or null
 *  if the error isn't a context complaint. Handles llama.cpp and OpenAI phrasings. */
export function parseContextLimit(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const patterns = [
    /available context size \((\d+)\s*tokens?\)/i, // llama.cpp: "exceeds the available context size (64000 tokens)"
    /"n_ctx"\s*:\s*(\d+)/i,                          // llama.cpp error JSON body
    /maximum context length is (\d+)\s*tokens?/i,    // OpenAI-style
    /context (?:window|length) of (?:only )?(\d+)/i,
    /reduce (?:the )?(?:length|input).*?(\d+)\s*tokens/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > 0) return n;
    }
  }
  return null;
}

/** True when an error is a context-overflow rejection (the request was too big
 *  for the window), by phrasing — even if no explicit number is present. */
export function isContextOverflow(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /exceed_context_size|exceeds the available context|maximum context length|context (?:window|length) of|too many tokens|reduce the length of/.test(
      msg,
    )
  );
}
