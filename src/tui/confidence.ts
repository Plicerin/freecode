// The earned-confidence badge state. It answers "is the CURRENT code verified?"
// — not "what did the last action do," not "tally of all actions." Derived only
// from the provenance ledger's real signals.
export type Confidence = "unchecked" | "verified" | "unverified" | "failing";

export interface LedgerSignals {
  verified: string[];
  believed: string[];
}

// Fold a turn's ledger into the next badge state. STICKY: a turn that neither
// changed nor verified anything (read-only) leaves the prior state untouched —
// so verification debt persists until something actually clears or breaks it.
export function nextConfidence(current: Confidence, ledger: LedgerSignals): Confidence {
  if (ledger.believed.some((b) => /failing|unconfirmed/i.test(b))) return "failing";
  if (ledger.believed.length) return "unverified";
  if (ledger.verified.length) return "verified";
  return current;
}

// Sidecar the contradiction-guard / overclaim warning onto the LAST assistant
// turn so the renderer paints a round-bordered block IMMEDIATELY below the
// assistant prose — visually PART OF the turn, not a post-script line dropped
// at the bottom of the transcript. The guard's finalText is the LAST assistant
// message in the provider's history; on the UI side the matching bubble is
// the LAST `role === "assistant"` message (a single tool-call-free turn is
// one bubble; a multi-tool turn is split into several — the LAST of which is
// what the warning qualifies). Pure function so the placement rule is testable
// without rendering.
//
// The returned array carries a structural side effect on ONE message:
// `{ ...target, warning: warningText }`, so React's keyed reconciliation reuses
// the existing assistant bubble (same `id`) and re-renders with the sidecar
// block attached — no new entry, no scroll jump.
//
// Falls back to appending a synthesized `role: "warning"` message at the end
// when no assistant bubble exists yet (e.g. a run that produced only tool
// calls). Losing inline placement is better than dropping the caution entirely.
export function attachWarning<T extends { role: string; warning?: string }>(
  messages: T[],
  warningText: string,
): T[] {
  const lastAssistantIdxFromEnd = [...messages].reverse().findIndex((m) => m.role === "assistant");
  if (lastAssistantIdxFromEnd === -1) {
    // Fallback: synthesize a sibling warning so the caution is never dropped.
    // T may not declare a `text` field; `as unknown as T` is the documented
    // escape hatch — the fallback is opt-out-by-leaking-type only, not by
    // silent shape mismatch. The synthesized shape satisfies `role: string`
    // and `warning?: string` from the constraint.
    return [...messages, { role: "warning", warning: undefined, text: warningText } as unknown as T];
  }
  const startIdx = messages.length - 1 - lastAssistantIdxFromEnd;
  // Reuse the existing assistant bubble with the sidecar field added — same
  // `id`, same content, just an extra `warning` prop that the renderer reads.
  const target = messages[startIdx]!;
  return [
    ...messages.slice(0, startIdx),
    { ...target, warning: warningText },
    ...messages.slice(startIdx + 1),
  ];
}

