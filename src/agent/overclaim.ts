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

// Sweeping completion language — "all/every/fully/completely ... implemented/done/
// fixed/working/pass/features", "fully implemented", "all missing features",
// "fully rebuilt", "all good", "everything works", etc. Deliberately narrow:
// a modest "fixed the typo" must NOT trip. Note: `good` is NOT here — modest
// status prose like "everything looks good on first read" would otherwise
// trip. The STRONG regex below still catches the sweeping `all good` and
// `everything's good` forms that are real completion claims.
const SWEEPING = /\b(?:all|every|everything|fully|completely|complete)\b[^.\n]{0,60}\b(?:implemented|complete[d]?|done|fixed|working|functional|pass(?:ed|es)?|features?|issues?|tests?|built|rebuilt|shipped|ready|resolved|stable)\b/i;
// Strong, short-form sweeps that don't need any surrounding context. The
// "fully rebuilt" case the handover flagged is here.
const STRONG = /\b(?:fully\s+(?:implemented|complete|working|functional|built|rebuilt|fixed|operational)|all\s+(?:good|done|ready|set|fixed)|every(?:thing)?\s+(?:is\s+)?(?:good|works?|passes?|ready|done)|now\s+(?:fully\s+|completely\s+)?(?:works?|passes?|ready|complete|done|fixed)|ready\s+to\s+(?:ship|merge|deploy|release)|build\s+(?:succeeded|passed|works?|passes?)|ship\s+(?:it|now)|everything'?s\s+(?:good|fixed|done))\b/i;

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

// The complementary failure: the final reply describes an EDIT ("I edited…",
// "I've updated…", "the file is now fixed…") but the turn ledger shows zero
// file changes. Real, observed contradiction — the model is asserting it did
// something it provably did not. Deliberately narrow: the verbs are explicit
// FILE-edit verbs (edited/updated/wrote/...); broader verbs like "I created a
// plan" or "I changed my approach" stay silent because they don't imply a file
// write, and a "fixed the bug" with no file change isn't a provable false claim.
const FIRST_PERSON_EDIT_VERB =
  /\b(?:I|we)(?:'ve|'re)?\s+(?:have|are)?\s*(?:just\s+|now\s+)?(?:edited|updated|wrote|rewritten|rewrote|saved|patched|modified|applied)\b/i;
// Past-state claim on a named file: "src/auth.ts is updated", "the file is fixed".
// Tolerates a single `now` adverb between is/was/etc. and the verb so common
// phrasings like "is now patched" and "has been updated" still match.
const FILE_STATE_PAST =
  /\b(?:the\s+(?:file|script|config)\b|\b\S+?\.[a-z]{1,5})\s+(?:is|has been|was|were)(?:\s+now)?\s+(?:updated|written|rewritten|rewrote|saved|edited|patched|modified|applied|created|fixed|moved|removed|deleted)\b/i;

export function editClaimWithoutChange(text: string, changedCount: number): string | null {
  if (changedCount > 0) return null;
  if (!text || !text.trim()) return null;
  const t = text.trim();
  if (FIRST_PERSON_EDIT_VERB.test(t)) {
    const snippets = grab(t, FIRST_PERSON_EDIT_VERB, 80);
    return `This reply claims an edit ("${snippets}…") but no files changed this turn — the claim contradicts the evidence. Treat as unverified.`;
  }
  if (FILE_STATE_PAST.test(t)) {
    const snippets = grab(t, FILE_STATE_PAST, 80);
    return `This reply states a file was changed ("${snippets}…") but no files changed this turn — the claim contradicts the evidence. Treat as unverified.`;
  }
  return null;
}

function grab(text: string, re: RegExp, max: number): string {
  const m = re.exec(text);
  if (!m) return text.slice(0, max);
  const s = Math.max(0, m.index - 10);
  const e = Math.min(text.length, m.index + m[0].length + 30);
  return text.slice(s, e).replace(/\s+/g, " ").slice(0, max).trim();
}
