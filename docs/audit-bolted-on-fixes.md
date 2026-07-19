# Audit: bolted-on quick fixes vs. root implementations

**Date:** 2026-06-11 · **Scope:** the agent loop (`src/agent/loop.ts`) + the resilience
helpers + the thin features. Pure utilities (parsing, formatting, providers) are out
of frame — "hack vs. root" doesn't apply to them.

**Honest headline:** most of what I *added this session* is **Category A** — compensation
for weak-local-model behavior (stalls, fumbles, narration, crawl), layered on WITHOUT
first confirming whether freecode's own request/prompt is *causing* that behavior. The
single highest-value root investigation — `freecode probe` freecode's request to gemma,
diff it against the same model in OpenCode — would likely make several of these
unnecessary. I patched effects instead of finding the cause.

---

## Category A — bolted-on quick fixes (the hacks)

Each reacts to a symptom; the root cause is elsewhere and fixable.

| Patch | Where | Masks (root cause) | Root fix |
|---|---|---|---|
| **Announced-action nudge** — detect "I'll check X" with no tool call → re-prompt "call the tool NOW" | `loop.ts:323+`, `text-tool-call.ts:announcedNextActionWithoutCalling` | WHY the same gemma emits tool calls in OpenCode but stalls in freecode (a real, unknown request difference) | probe-diff freecode vs OpenCode request; fix the difference; delete the nudge |
| **Text-tool-call warning** — detect `<function_calls>`/`<tool_call>` markup leaked as text → warn the user | `loop.ts:315`, `text-tool-call.ts:looksLikeTextToolCall` | freecode doesn't PARSE text-form tool calls; some local models only emit them that way | ✅ DONE — `text-tool-call.ts:parseTextToolCalls`/`filterTextToolCalls` parse the common formats (Qwen `<tool_call><function=…>`, Anthropic `<invoke>`, Hermes JSON) into structured calls and strip the markup (incl. stray leaked closers) in-stream, gated to non-native providers. The warning is now a genuine fallback for unparseable/unknown-tool markup. |
| **FileEdit correctionHint** — nudge the model when it sends empty/partial edit args | `file-edit.ts:correctionHint`, `loop.ts:381` | weak model fumbles FileEdit's exact-match contract | the *flexLocate* whitespace-tolerant match (same file) is the real fix; the hint is a crutch on top |
| **Server-timeout hint** — better error when a foreground server times out | `bash.ts:looksLikeLongRunningServer` | model ran a server in the foreground despite the prompt saying not to | this is mostly a prompt/model issue; the hint is a band-aid (low harm, but still reactive) |
| **Auto-continue on max_tokens** — re-prompt "continue from where you left off" | `loop.ts:305-313` | output cap too low, or model is verbose/non-converging | partly legitimate (truncation is real), but it papers over cap-sizing + a non-converging model |

## Category B — defensible resilience (reactive, but legitimate)

These handle genuinely external/unavoidable failures (provider quirks, untrusted model
output, network). Not hacks — but worth knowing they're reactive.

- **sanitizeToolPairing** (`loop.ts:200,477` / `sanitize.ts`) — guarantees tool_call/result pairing before send. *Required* — providers 400 on orphans. Correctness, not a hack.
- **Hard overflow stop** (`loop.ts:190-199`) — refuse to send a prompt bigger than the window. The *right* move (don't send a doomed request).
- **Hard trim guard** (`loop.ts:172-189`) — last-resort drop-oldest when compaction can't shrink enough.
- **Image-cap self-heal** (`image-cap.ts`, `loop.ts:282-291`) — learn a provider's per-request image limit from its 400, then apply it. Adaptive to an *unknowable-upfront* constraint — reasonable.
- **Circuit-breaker** (`loop.ts:467-472`) — stop after 8 consecutive tool failures. A backstop against infinite flailing.
- **Degeneration guard** (`degeneration.ts`) — abort on runaway repetition. A model collapse you must stop.
- **Crawl watchdog + streamHealth** (`speed.ts:streamHealth`, `repl` crawl effect) — *observability* only (warns; changes no behavior). Honest, but it labels a symptom rather than fixing slowness.
- **Empty-response / max-turns notices** (`loop.ts:317-321,492-494`) — surface a real model/agent failure plainly.

## Category C — root / proper

- **Verify gate** (`verify.ts`, `loop.ts:326-345`) — earns "done" by running real checks, feeds failures back. Original + sound.
- **Provenance ledger / overclaim guard** (`loop.ts` led, `overclaim.ts`) — machine-derived facts; flags unbacked success claims. Original.
- **Auto-compaction mechanism** (`context.ts`, `loop.ts:152-171`) — the mechanism is proper. ⚠️ but its *window source* is buggy (see below).
- **Secret redaction** (`loop.ts:402`, `redact.ts`), **vault**, **`freecode probe`**, **multi-provider** — real.
- **Fixes from this session that ARE root** — not all this session was hacks:
  - `[DONE]` tool-call flush (`openai-compat.ts`) — fixed a real parsing gap (calls dropped on clean EOF).
  - Local-endpoint normalize (`loader.ts:normalizeLocalBaseUrl`) — fixed 0.0.0.0-bind-vs-connect.
  - `/expand` from session log (`manager.ts:toolOutputs`) — fixed reading volatile context.
  - FileEdit `flexLocate` whitespace-tolerant match — makes the tool forgiving at the cause.

## Category D — thin / facade

- **/goal completion** (`goal.ts`) — model self-reports `GOAL: DONE`; no verification. Thin.
- **serve (gRPC)** (`serve.ts`) — `node:http` placeholder; no gRPC/protos.
- **Bedrock / Vertex** — honest stubs.

---

## Known real bugs surfaced (not hacks — actual defects to fix)

1. **Compaction sized to the server's `n_ctx`, not the model's reliable window.** llama-server reports `n_ctx=262144` (rope-extended) across 4 slots; freecode compacts at 80% of that (~210k) while the model degrades past ~128k. Worse: with `total_slots:4`, `default_generation_settings.n_ctx` may be *total*, so the real per-request window could be 64k and `parseLlamaServerContext` is 4× too high. (`local-context.ts`, `pricing.ts`). Workaround today: `FREECODE_CONTEXT_WINDOW`.
2. **No cloud-provider context detection.** DeepSeek's window is a hardcoded table value; no read-from-`/models`.

## The one investigation that would retire several Category-A hacks

`freecode probe` the request freecode sends gemma for a tool-requiring prompt, get the
same model's request in OpenCode, and **diff them**. The difference (tool serialization /
`tool_choice` / chat-template engagement / sampling / system-prompt bloat) is the root
cause of the stall + the text-leak. Fix it and the announced-action nudge AND the
text-tool-call warning likely become deletable.
