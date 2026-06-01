# OpenClaude — SPEC

## §G Goal

Provider-agnostic coding agent CLI. REPL + headless. Multi-LLM, multi-tool. Drop-in Claude Code with Anthropic lock-in removed. Bun runtime.

## §C Constraints

- **Runtime**: Bun (1.3+) — runtime, bundler, package manager, test runner.
- **TUI**: Ink + React 19. Box-drawing borders. chalk for color.
- **CLI**: Commander.js.
- **Validation**: Zod (config, tool args, profile, settings).
- **Tests**: `bun test`.
- **Providers (9)**: Anthropic, OpenAI + OpenAI-compat, Google Gemini, GitHub Models, AWS Bedrock, Google Vertex AI, Ollama, LM Studio, NVIDIA NIM.
- **Provider selection**: env vars `CLAUDE_CODE_USE_<PROVIDER>=1`. Each provider has matching `<PROVIDER>_API_KEY` (or AWS_*, GOOGLE_*, `OLLAMA_HOST`, `LMSTUDIO_HOST`, `NVIDIA_API_KEY`). Optional `<PROVIDER>_BASE_URL`.
- **Per-project profile**: `.openclaude-profile.json` at cwd root → `{provider, baseUrl, apiKey, model}`.
- **Settings priority**: CLI flags > `.openclaude-profile.json` > env vars > `~/.claude/settings.json`.
- **Settings file**: JSONC (comments + trailing commas OK). Hot-reload via file watcher.
- **Sessions**: append-only JSONL at `~/.claude/projects/<cwd-encoded>/<session-id>.jsonl`. One line per message or tool event. `/new` starts fresh, `/resume` picks existing.
- **Tools** (`!` = required, `?` = optional): Bash, FileRead, FileWrite, FileEdit, Glob, Grep, WebSearch, WebFetch.
- **Permissions**: 3 modes — `manual` (prompt each), `auto` (classifier), `bypass` (none). Denials tracked per session — denied call ! re-prompt on retry.
- **Themes**: dark + light. RGB constants fixed (see §I).
- **Streaming**: all providers stream text deltas + tool invocations. Agent loop ends on `end_turn` or `max_turns`.
- **Context**: per-turn token tracking, prompt cache where supported, auto-compact on threshold, extended thinking tracked separately.
- **Web search**: DuckDuckGo default (no key). Tavily/Exa/Firecrawl via env (`TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`).
- **Retries**: 10 default on rate limit, exp backoff. `CLAUDE_CODE_UNATTENDED_RETRY=1` → ∞ for CI.
- **Debug**: `CLAUDE_DEBUG=1` → verbose stderr.
- **Headless**: `--print` flag for one-shot script/CI use.
- **gRPC server**: `openclaude serve` — bidirectional `Chat` stream. Session id reconnect. Approval prompts as events.
- **Stubs**: every real-key provider ships a working mock so `openclaude` runs with zero config.

## §I Interfaces

```yaml
# CLI
cmd: openclaude [prompt...]            → REPL
cmd: openclaude --print [prompt...]     → headless one-shot, stdout text
cmd: openclaude serve [--port N]        → gRPC server
cmd: openclaude resume <session-id>     → /resume from CLI

# Env (selection)
env: CLAUDE_CODE_USE_ANTHROPIC=1
env: CLAUDE_CODE_USE_OPENAI=1
env: CLAUDE_CODE_USE_GEMINI=1
env: CLAUDE_CODE_USE_GITHUB_MODELS=1
env: CLAUDE_CODE_USE_BEDROCK=1
env: CLAUDE_CODE_USE_VERTEX=1
env: CLAUDE_CODE_USE_OLLAMA=1
env: CLAUDE_CODE_USE_LMSTUDIO=1
env: CLAUDE_CODE_USE_NIM=1

# Env (creds — pick matching)
env: ANTHROPIC_API_KEY  ! set for Anthropic
env: OPENAI_API_KEY     ! set for OpenAI-compat
env: GEMINI_API_KEY     ! set for Gemini
env: GITHUB_TOKEN       ! set for GitHub Models
env: AWS_ACCESS_KEY_ID  + AWS_SECRET_ACCESS_KEY + AWS_REGION
env: GOOGLE_APPLICATION_CREDENTIALS    # Vertex
env: OLLAMA_HOST        ? default http://127.0.0.1:11434
env: LMSTUDIO_HOST      ? default http://127.0.0.1:1234
env: NVIDIA_API_KEY     ! set for NVIDIA NIM (nvapi-...)

# Env (behavior)
env: CLAUDE_CODE_UNATTENDED_RETRY=1    # ∞ retries, CI only
env: CLAUDE_DEBUG=1                    # verbose stderr
env: TAVILY_API_KEY                    # web search
env: EXA_API_KEY
env: FIRECRAWL_API_KEY

# Files
file: .openclaude-profile.json    { provider, baseUrl?, apiKey?, model }
file: ~/.claude/settings.json     JSONC: { model, permissionMode, webSearchProvider, theme, ... }
file: ~/.claude/projects/<cwd>/<session-id>.jsonl   append-only

# Provider interface (TS)
api: stream(req: ChatRequest, ctx: Ctx) → AsyncIterable<StreamEvent>
api: models() → string[]
api: name: string

# Tool interface (TS)
api: name: string
api: schema: ZodSchema              # args validation
api: describe(): string             # for system prompt
api: run(args, ctx): Promise<ToolResult>
api: permission: 'safe' | 'confirm' | 'danger'  # classifier hint

# gRPC
svc: Chat(stream Request) returns (stream Event)
msg: Request { session_id?, message?, approve? }
msg: Event   { delta?, tool_call?, tool_result?, approval_request?, end?, error? }

# Slash commands
cmd: /model <name>           # switch active model
cmd: /new                    # start fresh session
cmd: /resume [id]            # pick or list
cmd: /context                # show token usage + cache state
cmd: /provider [name]        # show or switch provider
cmd: /help                   # list commands
cmd: /compact                # force context compaction

# Theme (RGB)
ui: assistant     rgb(215,119,87)
ui: permission    rgb(87,105,247)
ui: success       rgb(44,122,57)
ui: error         rgb(171,43,63)
ui: warning       rgb(150,108,30)

# Keyboard
key: Ctrl+C         exit
key: Ctrl+U         clear input
key: Ctrl+T         toggle tasks sidebar
key: Enter          submit
key: Tab            autocomplete slash command

# Error → friendly map
err: local_provider_unreachable  → "Local provider not running — please start Ollama"
err: model_not_found             → "Model not found — use /model to switch"
err: invalid_api_key             → "Invalid API key — check <PROVIDER>_API_KEY"
err: rate_limited                → "Rate limited — retrying with backoff"
err: context_overflow             → "Context window exceeded — auto-compacting"
```

## §V Invariants

```
V1:  ∀ provider call → AsyncIterable<StreamEvent> | graceful friendly error
V2:  ∀ turn → token usage recorded (input, output, cache_read, cache_write, thinking)
V3:  ∀ tool call denied once/session → same call ! re-prompt on retry
V4:  ∀ bash tool exec → cmd ! match denylist (rm -rf /, :(){ :|:&};:, etc.)
V5:  settings load order: CLI flags > .openclaude-profile.json > env > ~/.claude/settings.json
V6:  session file append-only — one JSON object per line, never mutate past rows
V7:  prompt cache markers applied where provider API supports
V8:  rate-limit response → exp backoff, max 10 retries (∞ if CLAUDE_CODE_UNATTENDED_RETRY=1)
V9:  TUI ! block on tool exec — tool runs in worker, main thread paints frames
V10: gRPC Chat stream bidirectional — caller can reconnect via session_id
V11: ∀ provider with real-key req → stub/mock impl ships, app runs with zero config
V12: ∀ tool arg → Zod-validated before exec; on fail → friendly error, no exec
V13: settings.json hot-reload → config changes propagate within 500ms
V14: context window utilization > 80% → auto-compact triggered
V15: extended thinking tokens tracked separately from text tokens
V16: JSONC parser must accept // and /* */ comments + trailing commas
V17: WEB_SEARCH provider env (TAVILY/EXA/FIRECRAWL) → overrides DuckDuckGo default
V18: permission mode 'bypass' → zero prompts, log denials only
V19: prefersReducedMotion → shimmer spinner → static indicator
V20: spinner shows for ∀ in-progress tool call
```

## §T Tasks

```
id|status|task|cites
T1|.|scaffold: package.json, tsconfig, dirs, deps|V1,V9
T2|.|settings loader: priority chain + JSONC parse + hot-reload watcher|V5,V13,V16
T3|.|provider interface + Anthropic stub + friendly error map|V1,V11
T4|.|provider OpenAI-compat stub (covers OpenAI, GitHub Models, LM Studio)|V1,V11
T5|.|provider Gemini stub|V1,V11
T6|.|provider Bedrock stub|V1,V11
T7|.|provider Vertex stub|V1,V11
T8|.|provider Ollama stub w/ "not running" detection|V1,V11
T9|.|session manager: JSONL append, /new, /resume, list|V6
T10|.|tool interface + Bash w/ allowlist+denylist|V4
T11|.|tool FileRead|V12
T12|.|tool FileWrite (atomic write, mkdir -p)|V12
T13|.|tool FileEdit (unified diff apply)|V12
T14|.|tool Glob (fast-glob, .gitignore-aware)|V12
T15|.|tool Grep (ripgrep-backed, respects .gitignore)|V12
T16|.|tool WebSearch (DuckDuckGo default, Tavily/Exa/Firecrawl backends)|V17
T17|.|tool WebFetch → markdown (turndown or similar)|V12
T18|.|permission system: manual/auto/bypass, denials set, classifier|V3,V18
T19|.|TUI shell: Ink, status bar, scroll region, input, footer, keybinds|V9
T20|.|slash command dispatcher: /model /new /resume /context /provider /help /compact|I.cmd
T21|.|theme: dark/light, fixed RGB constants, chalk helpers|I.ui
T22|.|spinner w/ shimmer + prefersReducedMotion|V19,V20
T23|.|agent loop: stream → tool exec → append → end_turn/max_turns|V1,V8
T24|.|context window mgmt: token tracking, auto-compact, cache markers, thinking|V2,V7,V14,V15
T25|.|headless --print mode (no TUI, one-shot)|I.cmd
T26|.|gRPC server: bidirectional Chat, session reconnect, approval events|V10
T27|.|CLI: Commander.js, subcommands, flags|I.cmd
T28|.|retry w/ exp backoff + jitter|V8
T29|.|error → friendly message map (V1 friendly errors)|I.err
T30|.|tests: settings, providers, session, tools, permissions, agent loop|V5,V6,V12
T31|.|README, .openclaude-profile.json schema, slash command docs|I.cmd
```

## §B Bug Log

```
id|date|cause|fix
```
