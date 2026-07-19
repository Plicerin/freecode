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

