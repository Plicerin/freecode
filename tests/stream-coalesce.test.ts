// Streamed reasoning/answer deltas are COALESCED and flushed to the transcript
// at ~30fps instead of one React commit per token — the fix for a heap leak
// where per-token rendering climbed to Node's ~4GB cap and OOM'd a long session
// (Ink retains heap on every commit). This pins that the coalesced assembly
// produces byte-for-byte the SAME transcript as flushing every delta, across
// reasoning→answer→tool→answer transitions.
import { test, expect, describe } from "bun:test";
import { planStreamFlush, type UiMessage } from "../src/commands/repl";

type Ev = { t: "think" | "text"; x: string } | { t: "tool"; x: string };

// Drive planStreamFlush the way the repl does: buffer deltas, flush at a
// configurable cadence (1 = per token, Infinity = only on discrete events/end).
function run(events: Ev[], flushEvery: number): { messages: UiMessage[]; flushes: number } {
  let messages: UiMessage[] = [];
  let thinkId: string | null = null;
  let answerId: string | null = null;
  let pendThink = "";
  let pendAnswer = "";
  let seq = 0;
  let since = 0;
  let flushes = 0;
  const newId = (kind: "reasoning" | "assistant"): string => `${kind === "reasoning" ? "think" : "a"}-${seq++}`;
  const flush = (): void => {
    if (!pendThink && !pendAnswer) return;
    flushes++;
    const plan = planStreamFlush({ thinkId, answerId }, { think: pendThink, answer: pendAnswer }, newId);
    pendThink = "";
    pendAnswer = "";
    thinkId = plan.thinkId;
    answerId = plan.answerId;
    messages = plan.apply(messages);
  };
  for (const e of events) {
    if (e.t === "think") { pendThink += e.x; if (++since >= flushEvery) { flush(); since = 0; } }
    else if (e.t === "text") { pendAnswer += e.x; if (++since >= flushEvery) { flush(); since = 0; } }
    else { flush(); since = 0; thinkId = null; answerId = null; messages = [...messages, { id: `tool-${seq++}`, role: "tool", text: e.x }]; }
  }
  flush();
  return { messages, flushes };
}

const norm = (ms: UiMessage[]): string => ms.map((m) => `${m.role}:${m.text}`).join("\n");

describe("planStreamFlush: coalesced streaming equals per-token streaming", () => {
  const events: Ev[] = [];
  for (let i = 0; i < 50; i++) events.push({ t: "think", x: `T${i} ` });
  for (let i = 0; i < 80; i++) events.push({ t: "text", x: `A${i} ` });
  events.push({ t: "tool", x: "→ Bash(ls)" });
  for (let i = 0; i < 60; i++) events.push({ t: "text", x: `B${i} ` });
  events.push({ t: "tool", x: "→ Grep(x)" });
  for (let i = 0; i < 40; i++) events.push({ t: "text", x: `C${i} ` });

  test("final transcript is byte-for-byte identical regardless of flush cadence", () => {
    const perToken = run(events, 1);
    const coalesced = run(events, Number.POSITIVE_INFINITY);
    expect(norm(coalesced.messages)).toBe(norm(perToken.messages));
    // …and coalescing did far fewer flushes (fewer React commits).
    expect(coalesced.flushes).toBeLessThan(perToken.flushes);
  });

  test("bubble structure is reasoning → answer → tool → answer → tool → answer", () => {
    const { messages } = run(events, Number.POSITIVE_INFINITY);
    expect(messages.map((m) => m.role)).toEqual(["reasoning", "assistant", "tool", "assistant", "tool", "assistant"]);
    // the three answer segments carry their own text, not merged
    const answers = messages.filter((m) => m.role === "assistant");
    expect(answers[0]!.text.startsWith("A0 ")).toBe(true);
    expect(answers[1]!.text.startsWith("B0 ")).toBe(true);
    expect(answers[2]!.text.startsWith("C0 ")).toBe(true);
  });
});

describe("planStreamFlush: unit behaviour", () => {
  test("creates a reasoning bubble when none exists, appends when it does", () => {
    const p1 = planStreamFlush({ thinkId: null, answerId: null }, { think: "hel", answer: "" }, () => "think-0");
    const m1 = p1.apply([]);
    expect(m1).toEqual([{ id: "think-0", role: "reasoning", text: "hel" }]);
    expect(p1.thinkId).toBe("think-0");
    const p2 = planStreamFlush({ thinkId: "think-0", answerId: null }, { think: "lo", answer: "" }, () => "UNUSED");
    expect(p2.apply(m1)).toEqual([{ id: "think-0", role: "reasoning", text: "hello" }]);
  });

  test("the first answer text closes the reasoning bubble (returns thinkId null)", () => {
    const p = planStreamFlush({ thinkId: "think-0", answerId: null }, { think: "", answer: "hi" }, () => "a-0");
    expect(p.thinkId).toBeNull();
    expect(p.answerId).toBe("a-0");
  });

  test("a no-op flush (empty pending) doesn't allocate a new id", () => {
    let called = false;
    const p = planStreamFlush({ thinkId: null, answerId: null }, { think: "", answer: "" }, () => { called = true; return "x"; });
    expect(called).toBe(false);
    expect(p.apply([{ id: "u", role: "user", text: "hi" }])).toEqual([{ id: "u", role: "user", text: "hi" }]);
  });
});
