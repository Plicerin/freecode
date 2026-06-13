# freecode — Handover

**Date:** 2026-06-13 · **Branch:** `feat/tier-a-parity` · **HEAD:** `c92ae08` · 222 commits · 558 tests green · typecheck clean.

This is an honest state-of-the-project document, written when the owner paused the project. It reports what *exists and is verified*, what *doesn't work*, and what's *unfinished* — not what was intended. Read it as a pick-up guide, not a pitch.

---

## What freecode is

A provider-agnostic coding agent (Bun + Ink/React + TypeScript): a Claude-Code-style REPL + headless mode that runs any model from any provider (Anthropic, OpenAI, Gemini, Ollama, LM Studio, llama-server, DeepSeek, OpenRouter, NIM, …) through one agent loop, with self-verification, permissions, MCP, subagents, skills, plugins, and a git/PR workflow.

**Run it:**
```bash
bun install
bun test                       # 558 tests
bun run src/cli.tsx            # REPL (mock provider, no key)
```
The owner runs it from source via a shell function: `freecode → bun run src/cli.tsx`. So **every commit is live on the next invocation — no build step.** There is no compiled exe in normal use.

---

## The honest state of the world (the central finding)

The project ran into one wall, and it's important the next person understands exactly where it is.

**The harness is sound.** With a *capable* model it works end-to-end. Verified live this session: **Opus 4.1 (via OpenRouter)** driving freecode fixed real Rust compile errors in a Tauri app, raised the command timeout itself, ran `tauri:build`, and produced shippable NSIS + MSI installers — and freecode's verify gate confirmed it. Orientation, the permission/verify path, `/scan` discovery, streaming, and the guards all work.

**The local-model story is unproven for complex agentic work — this is the open problem.** 14B-class local models (tested: `qwen2.5:14b`, `qwen2.5-coder:14b` on Ollama) handle *simple* calls fine but flail on real multi-step edits. Observed, repeatedly:
- **Wrong domain knowledge** — e.g. setting a Tauri window size by editing `build.defaultWidth` instead of `app.windows[0].width`. It guessed the schema instead of grounding in the file it had just read.
- **Edit-format fumbling** — multiple failed `FileEdit` attempts per change.
- **Tool calls emitted as TEXT** — the model writes a correct call as JSON in its content, but the Ollama chat template doesn't wrap it, so the server returns no structured `tool_calls`. (Root cause is server-side: the template, or run via `llama-server --jinja`, or a model whose template wraps calls. The non-coder `qwen2.5:7b/14b` templates DO return structured calls; the `qwen2.5-coder` ones did not — confirmed by probe on two boxes.)
- **False "done" claims** — declaring an app "fully rebuilt" after a build that aborted/failed.

These are **model-capability limits, not harness bugs** — but freecode does not yet catch all of them honestly (see Known Issues). The promising local paths were **never tested**: `qwen2.5-coder` via `llama-server --jinja`, and **devstral** (purpose-built for agentic coding, present on the `gaiking` box). If the next person wants the local story, *that* is the experiment to run before concluding it can't work.

---

## Known issues / unfinished (be precise: written vs not)

### A workaround the owner flagged — recommend reverting
- **`recoverTextToolCall` (commit `c92ae08`)** scrapes a tool call out of the model's text content when the server returns no structured `tool_calls`, and executes it. The owner correctly called this a **compensating hack**: it papers over a problem we'd already root-caused to the *server* (the chat template not wrapping calls). It also didn't deliver — the recovered build still aborted, and the model still lied about success on top of it. **Recommendation: revert `c92ae08`'s loop change and fix at the source** (template / `--jinja` / a model that emits structured calls). The `diff`-alias half of `c92ae08` (FileEdit accepting `diff` + deriving the path from the header) is a genuine input-robustness fix and can stay.

### Not written (no code exists — do not treat as pending status)
1. **Contradiction-guard** — flag when the final reply claims it edited a file but 0 files actually changed this turn (`changedCount === 0`). The data is already in the turn ledger (`src/agent/loop.ts` ~line 526).
2. **Failed-build → overclaim escalation** — the overclaim guard (`src/agent/overclaim.ts`) only counts *recognized* checks; `npm run tauri:build` / `cargo build` aren't recognized, so a failed build doesn't escalate the warning, and non-sweeping claims like *"fully rebuilt"* slip the regex entirely. The model lied "fully rebuilt" after an aborted build and nothing flagged it. Broaden the check recognizer and the claim regex.
3. **Cold-load retry** — the first request to a freshly-loaded Ollama model returns empty (`end_turn`, no content); the immediate retry works. freecode treats the empty turn as "nothing to do." Retry once on an empty just-connected turn.

### Real, accepted limits
- `tauri:build` (Rust compile) exceeds the 120s Bash timeout; a capable model raises `timeoutMs` itself, a weak one doesn't.
- `src/commands/repl.tsx` is 2,529 lines — the TUI state machine is large; pickers can't be unit-tested headless (verified by typecheck + mirroring existing working pickers).

---

## Architecture map (where to look)

- **`src/agent/loop.ts`** (597 lines) — the agent loop: streaming, tool execution, auto-continue, verify gate, the turn ledger, compaction. The heart.
- **`src/providers/openai-compat.ts`** — OpenAI-style request building + SSE streaming + tool-call accumulation. `src/providers/anthropic.ts` for the Anthropic path. `src/providers/registry.ts` builds a provider from resolved config (`ensureV1` adds `/v1` for local servers).
- **`src/config/loader.ts`** — config resolution chain: flag > profile > env > settings > remembered > default. `normalizeLocalBaseUrl` for local servers.
- **`src/providers/server-discovery.ts`** — `/scan`: probes localhost + Tailscale peers + LAN /24 for Ollama + llama-server.
- **`src/agent/environment.ts`** — the project-root / orientation block injected into the system prompt (so the agent isn't fooled by its cwd).
- **`src/agent/overclaim.ts`** + the ledger in `loop.ts` — the honesty guards (verified / observed / believed; overclaim warning).
- **`src/tools/`** — Bash, FileRead/Write/Edit, Glob, Grep, Web*, ViewImage, Skill. `structured-validate.ts` rejects writes that corrupt JSON.
- **`src/commands/repl.tsx`** — the entire TUI (pickers, slash commands, rendering).
- **`SPEC.md`**, **`ROADMAP.md`**, **`PARITY_AUDIT.md`** — design + parity tracking.

---

## Honest recommendation for whoever picks this up

freecode-the-harness is good and worth keeping; with a frontier model it's a capable, honest coding agent. The unanswered question is the one that motivated the project: **can a local model in a normal hardware budget drive it well enough to be worth using over a frontier model?** That was never fairly tested — the runs that failed used a general (non-coder) model through a server that didn't emit structured tool calls, with two harness bugs in the loop (since fixed) and one compensating hack (recommend reverting). The clean experiment is still open:

1. Revert the `recoverTextToolCall` hack; fix tool-calling at the server (`--jinja`, or a model whose template wraps calls).
2. Run a representative task (e.g. the Tauri window-size edit) on **devstral** and on **qwen-coder via llama-server `--jinja`**.
3. Write the three unwritten guards above so failures are *observable and honest* rather than silent.

If a strong local model still can't do it, the honest conclusion is that freecode is a frontier-model tool — and that's a legitimate product, just not the one originally aimed at.
