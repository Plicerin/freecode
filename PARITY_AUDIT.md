# freecode vs OpenClaude — Current Parity Audit

**Audit date:** 2026-07-31

**freecode:** v0.1.13, current working tree

**OpenClaude:** v0.27.0, `main` at `b3735be` (2026-07-31)

**Method:** inspected both repositories directly. Counts are filesystem inventories, not marketing claims. OpenClaude was not built or tested locally; freecode's current suite passed 906 tests.

## Executive verdict

freecode is no longer just a single-agent REPL. Since the previous audit it has added typed sub-agents, parallel workflows, dynamic `/ultraplan`, skills, installable plugins, project-scoped Honcho memory, OAuth, background jobs, Git/PR commands, server discovery, file recovery, and substantially stronger verification and security controls.

It is still not at platform parity with OpenClaude. The remaining difference is less about the core coding loop and more about **product surface and platform infrastructure**: OpenClaude has a real SDK and gRPC backend, remote/mobile operation, IDE/LSP support, deep integrations, a much larger plugin platform, more session tooling, more transports, and a far broader TUI/command surface.

A single “percent parity” number would be misleading. For its intended local coding-agent workflow, freecode covers much of the important core. As an extensible, remotely controllable platform, it covers only a subset.

## Scale snapshot

| Measure | freecode | OpenClaude | Interpretation |
|---|---:|---:|---|
| Files under `src/` | 128 | 3,091 | OpenClaude remains about 24× larger by source-file count |
| Test files / test-like files | 136 | 635 | Counts are structural; only freecode was executed in this audit |
| Built-in slash-command list | 43 entries | 112 command directories plus root/feature-gated commands | Not directly comparable because aliases, plugins, skills, and internal commands are dynamic |
| Providers | 10 implemented + mock; 2 honest stubs | Broader gateway/cloud catalog | freecode now includes OpenRouter and DeepSeek, but still lacks several native cloud backends |

The old “60 files / 16 commands / no agents, plugins, or memory” description is obsolete.

## What freecode now has

### Strong core agent workflow

- Streaming multi-provider agent loop with tool calls, thinking channels, retries, rate limiting, context healing, compaction, prompt caching, image input, and degeneration guards.
- Core tools: Bash, file read/write/edit, glob, grep, web search/fetch, image viewing, Agent, and Skill, plus MCP-contributed tools.
- Verification gate, provenance ledger, confidence reporting, backup-before-write, structured-file validation, repeated-failure protection, and bounded tool output.
- Interactive REPL, headless one-shot mode, background jobs, resumable sessions, and persistent conversation state.

### Agents and orchestration

- Built-in and user/project/plugin-defined sub-agent types with per-agent tool allowlists.
- An Agent tool that runs bounded child loops and surfaces their tool activity.
- Declarative workflows with sequential stages, bounded parallel fan-out, task caps, and stage barriers.
- Dynamic `/ultraplan` workflow composition using the same validated workflow schema.
- `/explore`, `/agents`, `/advisor`/`/consult`, `/goal`, and workflow management commands.

This closes the previous claim that freecode was strictly single-agent. It does **not** equal OpenClaude's remote agents platform, worktree isolation, richer task UI, or cloud orchestration.

### Plugins, skills, and customization

- User, project, and plugin skills loaded on demand.
- Plugins installable from Git or a local directory with validated names and atomic staging.
- Plugin contributions for commands, agents, skills, and workflows.
- Enable, disable, uninstall, and contribution discovery.
- Custom Markdown slash commands and custom agent definitions.

This is a functional lightweight plugin system. It is not yet a marketplace platform: there is no dependency resolution, signed/trusted publisher model, update policy, lockfile, compatibility negotiation, plugin hooks, plugin MCP servers, LSP contributions, or marketplace browser.

### Memory, learning, and recovery

- Project-scoped cross-session Honcho memory with fail-soft operation, redaction, caching, semantic recall, and background ingestion.
- `/memory` status/show/refresh.
- `/learn` can propose durable rules or skills, track whether they fire, and prune unused artifacts.
- Append-only sessions, resume/rename, conversation-state persistence, compaction, and file recovery from snapshots/session evidence.

This is useful memory and recovery, but not full knowledge/session parity. Missing pieces include first-class conversation rewind/branching, replay timelines, session export/share, wiki/knowledge indexes, and migration tooling.

### Git and delivery workflow

- `/diff`, `/commit`, `/branch`, `/commit-push-pr`, `/issue`, `/pr-comments`, `/review`, `/security-review`, and `/autofix-pr`.
- Commands degrade honestly when Git or GitHub CLI capabilities are unavailable.

The previous Stage 1 Git/PR roadmap is substantially complete.

### Providers, OAuth, and local networking

Implemented providers or endpoints:

- Anthropic
- OpenAI-compatible OpenAI
- GitHub Models
- Google Gemini
- Ollama
- LM Studio
- llama.cpp server
- NVIDIA NIM
- DeepSeek
- OpenRouter
- Mock/offline provider

OpenAI/ChatGPT and Anthropic/Claude OAuth flows are implemented alongside API-key vault support. Bedrock and Vertex remain explicit, honest stubs.

Local server discovery probes Ollama and llama-server endpoints across localhost, LAN hosts, and Tailscale/MagicDNS peers. WebFetch's SSRF/DNS pinning is deliberately isolated from provider and discovery traffic, so it does not block configured tailnet model servers.

## Current parity matrix

| Area | Status | Notes |
|---|---|---|
| Core coding-agent loop | Strong | Competitive local core; freecode adds verification-first behavior |
| Core tools | Strong | Main coding tools plus Agent/Skill/MCP; fewer specialized tools |
| Git/PR workflow | Strong subset | Covers the highest-value daily flows |
| Providers | Good subset | OpenRouter expands reach; Bedrock/Vertex are still missing |
| OAuth and vault | Good subset | OpenAI + Anthropic OAuth and encrypted local vault |
| Sub-agents | Functional subset | Typed and bounded, but no remote/worktree agent platform |
| Workflows | Functional subset | Parallel staged workflows and dynamic composition |
| Plugins and skills | Functional subset | Local/Git bundles; no marketplace lifecycle or deep contribution APIs |
| Memory | Functional subset | Honcho-backed and project-scoped; no wiki/knowledge/session graph |
| Sessions | Good core | Resume, rename, compaction, recovery; no rewind/replay/export/share |
| Hooks | Basic | PreToolUse, PostToolUse, Stop; much smaller event/ policy surface |
| Config and diagnostics | Basic | `/config` and `/doctor` exist, but doctor is shallow and config is read-only |
| MCP | Partial | Stdio client only; no Streamable HTTP/SSE transport |
| Headless automation | Partial | One-shot and background jobs; lacks stable JSON/stream-JSON protocol and fine-grained budgets/allowlists |
| Themes/TUI | Basic | Dark/light and core panels; no customizable keybindings, Vim, output styles, or richer screens |
| Backend/API | Missing | `serve` is an HTTP health placeholder, not an agent service |
| SDK | Missing | No supported programmatic API package |
| Remote/mobile | Missing | No remote control, teleport, phone UI, or session bridge |
| IDE/LSP | Missing | No VS Code integration or language-server diagnostics |
| Integrations | Missing | No GitHub App, Slack, or managed integration platform |
| Config migrations | Missing | No versioned migration framework for evolving settings/state |

## Most important remaining product gaps

### P0 — Build a real backend, not a placeholder

This is the largest practical gap and explains why a client can report “backend unavailable” even while `freecode serve` binds a port. The process currently exposes only a JSON health response; it cannot create an agent session or stream a turn.

A minimum useful backend should provide:

1. Liveness and readiness endpoints that distinguish “process running” from “provider/model usable.”
2. Provider/model discovery and diagnostics.
3. Session create/list/resume endpoints.
4. A streaming chat/agent endpoint with text, thinking, tool-call, approval, verification, and completion events.
5. Cancellation and background-job status.
6. Loopback-only binding by default; explicit LAN/Tailscale binding with token authentication.
7. End-to-end tests using the same AgentLoop as the REPL, so CLI and server behavior cannot drift.

Protocol choice should follow the intended client. HTTP + SSE is the smallest interoperable first release; gRPC can follow if a typed bidirectional protocol or OpenClaude compatibility is a real requirement.

### P0 — Make diagnostics test the real failure modes

`/doctor` currently reports configuration facts but does not prove that the selected endpoint resolves, connects, lists the configured model, or can stream a token. Extend it with safe, bounded probes and clear layers:

- DNS resolution
- TCP/TLS connectivity
- provider authentication
- `/models` or provider equivalent
- selected-model availability
- optional one-token streaming smoke test
- Tailscale/MagicDNS discovery status for local providers
- backend readiness when `serve` is enabled

### P1 — Stabilize automation interfaces

- Add `--output json` and `--output stream-json` with a versioned event schema.
- Add CLI tool allowlists/denylists, turn/token/cost budgets, and deterministic exit codes.
- Make background jobs resumable and observable through both CLI and the future backend.
- Publish a small SDK only after the event/session contracts are stable.

### P1 — Complete transport and session fundamentals

- Add MCP Streamable HTTP support; retain stdio.
- Add session export, summary, rewind/branch, and replay before building social sharing.
- Add a settings/state migration framework before formats accumulate more incompatible versions.
- Add configurable keybindings after the command/session model is stable.

### P2 — Deep platform extensions

- IDE/LSP diagnostics and VS Code integration.
- Plugin trust, updates, dependency resolution, compatibility metadata, and richer contribution types.
- Remote/mobile control over the real backend.
- GitHub App and Slack integrations.
- Native Bedrock and Vertex providers, driven by user demand rather than checklist parity.

## What should not be prioritized merely for parity

- Recreating every upstream slash command.
- Decorative TUI breadth before backend reliability.
- A plugin marketplace before plugin trust/versioning exists.
- More provider logos before current endpoints have strong diagnostics.
- Remote/mobile clients before the server protocol is real and authenticated.

## Recommended product direction

Keep freecode's identity as the smaller, verification-first agent rather than cloning a 3,000-file platform feature for feature. The next coherent milestone is:

> **A dependable local/Tailscale agent service:** the same verified AgentLoop as the REPL, exposed through an authenticated streaming API, with diagnostics that identify DNS, endpoint, model, and provider failures precisely.

That milestone improves the actual product, resolves the backend-availability problem at its root, enables future SDK/remote/IDE work, and preserves freecode's strongest differentiation: evidence-backed completion rather than surface-area parity.
