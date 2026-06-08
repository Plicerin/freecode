// Catch the most corrosive agent failure: a sweeping "all done / fully
// implemented" claim in the final message that the evidence doesn't support.
// freecode can't judge whether the work is CORRECT, but it can tell when a
// completion claim was made with nothing verified (or with a check failing) and
// say so out loud — so a false green is surfaced, not buried under confident
// prose. Evidence over confidence: we report what was (not) seen.

export interface ClaimEvidence {
  changedCount: number; // files written/edited this run
  verifiedCount: number; // checks freecode confirmed passed (gate or recognized agent-run)
  anyFailed: boolean; // a check failed this run
}

// Sweeping completion language — "all/every/fully/completely ... implemented/
// done/fixed/working/pass/features", "fully implemented", "all missing features",
// "now works", etc. Deliberately narrow: a modest "fixed the typo" must NOT trip.
const SWEEPING = /\b(?:all|every|everything|fully|completely|complete)\b[^.\n]{0,60}\b(?:implemented|complete[d]?|done|fixed|working|functional|pass(?:ed|es)?|features?|issues?|tests?)\b/i;
const STRONG = /\bfully (?:implemented|complete|working|functional)\b|\ball (?:missing )?(?:features?|issues?|gameplay|requirements?)\b|\bnow (?:fully )?(?:works?|complete|implemented|functional)\b/i;

export function claimsSweepingSuccess(text: string): boolean {
  return SWEEPING.test(text) || STRONG.test(text);
}

/** A warning when a sweeping success claim isn't backed by evidence; else null. */
export function overclaimWarning(finalText: string, ev: ClaimEvidence): string | null {
  if (!claimsSweepingSuccess(finalText)) return null;
  if (ev.anyFailed) {
    return "This reply claims success, but a check is FAILING — the claim contradicts the evidence. Don't trust the \"done\".";
  }
  if (ev.verifiedCount === 0) {
    return `This reply claims completion, but freecode confirmed no passing check this turn (${ev.changedCount} file(s) changed). That's the model's assertion, not a verified result — check it before trusting it.`;
  }
  return null; // claimed success AND something verified passed → let it stand
}
