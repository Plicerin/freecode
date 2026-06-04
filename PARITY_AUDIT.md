# freecode — Feature Parity Audit

**Date:** 2026-06-04
**Auditor:** Claude (code-verified, not assumed)
**Parity target:** `SPEC.md` (freecode's design spec = the Claude Code / OpenClaude feature surface it was built to match).

> ⚠️ **Caveat on "vs OpenClaude":** OpenClaude's source is not available in this workspace (no upstream git remote, no local checkout). This audit is therefore against **`SPEC.md`**, freecode's own documented parity target — a strong proxy, but **not** a line-by-line diff of OpenClaude. To upgrade this to a true OpenClaude comparison, point me at the OpenClaude repo (URL or path) and I'll re-run it as a real diff.

---

## Verdict

freecode **meets or exceeds** the spec on the core agent loop, providers, tools, sessions, permissions, context, and TUI. The parity gaps are concentrated in **four** areas, only one of which is substantial (gRPC `serve`). It also ships a large amount of functionality **beyond** the spec.

---

## ❌ Parity gaps (missing / stub vs SPEC)

| # | Spec item | Status | Severity |
|---|---|---|---|
| 1 | **gRPC `serve`** — T26, V10, §I `svc: Chat` | **Placeholder.** `serve.ts` binds an HTTP port returning `{name,status,grpc:true}`; there is **no** proto loader, bidirectional `Chat` stream, session reconnect, or approval-as-events. Comment admits "placeholder… replace with @grpc/grpc-js + proto-loader." The grpc deps are installed but unused. | **High** — a whole spec'd interface is non-functional. |
| 2 | **AWS Bedrock (T6) + Google Vertex (T7) providers** | **Unimplemented stubs** — `registry.ts` routes both to `UnimplementedProvider` (returns a clear "not implemented" error). So **7 of 9** spec'd providers are real. | **Medium** — honest, but 2 providers short of the "9 providers" spec. |
| 3 | **Tasks sidebar (Ctrl+T, part of T19)** | **Stub.** Toggles a panel that always reads "Tasks / (no active tasks)" — no task/todo tracking behind it. | **Low** — cosmetic; no real feature. |
| 4 | **Spinner `prefersReducedMotion` → static (V19)** | **Missing.** A spinner exists (V20 ✓) but there is no reduced-motion fallback to a static indicator. | **Low.** |

Minor: §I lists `freecode resume <id>` as a subcommand; only `--resume <id>` (flag) exists. Functionally equivalent, cosmetically off-spec.

---

## ✅ At parity (code-verified)

- **Providers (7/9):** Anthropic, OpenAI-compat (covers OpenAI/GitHub Models/LM Studio/NIM), Gemini, Ollama + explicit Mock (V11 zero-config). Streaming + tool calls live-verified earlier.
- **Tools (T10–T17):** Bash (allow/denylist V4), FileRead, FileWrite, FileEdit, Glob, Grep, WebSearch (DuckDuckGo default + Tavily/Exa/Firecrawl), WebFetch→markdown.
- **Sessions (T9/V6):** append-only JSONL, `/new`, `/resume`, list. (Path is `~/.freecode/projects/…` not `~/.claude/…` — an intentional, correct divergence.)
- **Permissions (T18):** manual / auto / bypass, per-session denial memory (V3, V18).
- **Settings (T2):** priority chain (V5), JSONC (V16), **hot-reload watcher present** (chokidar in `settings-jsonc.ts`, V13).
- **Context (T24):** token tracking (V2), prompt-cache markers (V7), auto-compaction (V14), extended thinking tracked separately (V15).
- **Retries (T28):** exp backoff + jitter, `CLAUDE_CODE_UNATTENDED_RETRY` ∞ (V8).
- **Errors (T29):** friendly map (V1).
- **TUI (T19), themes (T21), slash commands (T20), headless `--print` (T25), keybinds.**

---

## ➕ Beyond spec (freecode exceeds OpenClaude's surface)

Encrypted API-key vault + first-run onboarding · MCP client (stdio) · verification gate + provenance ledger + earned-confidence badge · lifecycle hooks (PreToolUse/PostToolUse/Stop) · plan mode · custom slash commands · fuzzy command/@path matching · secret redaction across tool output + logs · repeated-failure circuit-breaker · performance "ghost" ledger (`/bench`) · activity log (`/log`) · `/about` `/rename` `/exit` · branding (Bubo, blue/grey identity).

---

## Recommended punch-list (to close SPEC parity)

1. **gRPC `serve`** — implement real `@grpc/grpc-js` + proto-loader bidirectional `Chat` (deps already present). *Biggest gap; most effort.*
2. **Bedrock + Vertex** — real SigV4 (Bedrock) and service-account (Vertex) auth, or formally de-scope them from the spec.
3. **Tasks sidebar** — either wire a real task/todo model or remove the Ctrl+T stub.
4. **`prefersReducedMotion`** — static spinner fallback (small).
5. **`resume` subcommand** — add `freecode resume <id>` to match §I (small).

## Open item for a *true* OpenClaude diff
Provide the OpenClaude repo and I'll diff command-for-command, tool-for-tool, and flag any behavior freecode implements *differently* (not just missing) — which SPEC-based auditing can't catch.
