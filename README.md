# freecode

Provider-agnostic coding agent CLI. REPL + headless. Multi-LLM, multi-tool. Drop-in Claude Code with the Anthropic lock-in removed. Bun runtime.

## Quick start

```bash
bun install
bun test                  # 17 unit tests
bun run src/cli.tsx       # launch REPL (mock provider — no API key needed)
```

First run uses the **Mock provider** so the app works with zero config. Wire a real provider by setting env vars or `.freecode-profile.json` (see below).

## Providers

Set the active provider with an env flag, then supply the matching key:

| Provider        | Selector                                | Key env var (or alt)                |
|-----------------|-----------------------------------------|-------------------------------------|
| Anthropic       | `CLAUDE_CODE_USE_ANTHROPIC=1`           | `ANTHROPIC_API_KEY`                 |
| OpenAI          | `CLAUDE_CODE_USE_OPENAI=1`              | `OPENAI_API_KEY`                    |
| GitHub Models   | `CLAUDE_CODE_USE_GITHUB_MODELS=1`       | `GITHUB_TOKEN`                      |
| Google Gemini   | `CLAUDE_CODE_USE_GEMINI=1`              | `GEMINI_API_KEY`                    |
| AWS Bedrock     | `CLAUDE_CODE_USE_BEDROCK=1`             | `AWS_ACCESS_KEY_ID` + secret + region |
| Google Vertex   | `CLAUDE_CODE_USE_VERTEX=1`              | `GOOGLE_APPLICATION_CREDENTIALS`    |
| Ollama          | `CLAUDE_CODE_USE_OLLAMA=1`              | `OLLAMA_HOST` (default `http://127.0.0.1:11434`) |
| LM Studio       | `CLAUDE_CODE_USE_LMSTUDIO=1`            | `LMSTUDIO_HOST` (default `http://127.0.0.1:1234`) |
| NVIDIA NIM      | `CLAUDE_CODE_USE_NIM=1`                 | `NVIDIA_API_KEY` (`nvapi-...`); base `https://integrate.api.nvidia.com/v1` |

Without a flag, freecode auto-detects whichever key is set.

## Per-project profile

`.freecode-profile.json` in your project root overrides env settings for that project only:

```json
{
  "provider": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o"
}
```

## Settings priority

`CLI flags > .freecode-profile.json > env vars > ~/.freecode/settings.json`

`settings.json` is JSONC (comments and trailing commas allowed) and hot-reloads on save:

```jsonc
// ~/.freecode/settings.json
{
  "model": "claude-sonnet-4-5",
  "permissionMode": "manual",         // manual | auto | bypass
  "webSearchProvider": "duckduckgo",  // duckduckgo | tavily | exa | firecrawl
  "theme": "dark",                    // dark | light
  "maxTurns": 50,
  "contextThreshold": 0.8,
  "enablePromptCache": true,
  "enableExtendedThinking": false
}
```

## CLI flags

```text
freecode                                    # REPL
freecode --prompt "..."                     # REPL with initial prompt
freecode --print --prompt "..."             # headless one-shot
freecode --resume <session-id>              # resume a session in REPL
freecode --serve --port 50051               # gRPC server (placeholder)
freecode --provider openai --model gpt-4o   # override provider
freecode --permission-mode bypass           # skip all prompts
```

## Slash commands (REPL)

| Command    | What it does                                  |
|------------|-----------------------------------------------|
| `/model`   | Show or switch model                          |
| `/new`     | Start a fresh session                         |
| `/resume`  | List sessions or resume by id                 |
| `/context` | Show token usage + cost                       |
| `/provider`| Show or switch provider                       |
| `/help`    | List commands                                 |
| `/compact` | Force context compaction                      |

## Keyboard

`Ctrl+C` exit · `Ctrl+U` clear input · `Ctrl+T` toggle tasks sidebar · `Tab` autocomplete slash · `Enter` submit

## Tools

`Bash` · `FileRead` · `FileWrite` · `FileEdit` · `Glob` · `Grep` (ripgrep) · `WebSearch` · `WebFetch`

Bash has a denylist for `rm -rf /`, fork bombs, sudo, `mkfs`, `dd if=`, piped shell, `chmod -R 777 /`. Grep wraps `rg` and ignores `.git/`, `node_modules/`, `dist/`.

## Permissions

- `manual` — prompt for every non-safe tool
- `auto` — auto-approve safe tools (`FileRead`, `Glob`, `Grep`, `WebSearch`, `WebFetch`), prompt the rest
- `bypass` — no prompts, log only

Denials are remembered per session, so the same call is not re-prompted on retry.

## Headless / CI

```bash
CLAUDE_CODE_UNATTENDED_RETRY=1 \
  bun run src/cli.tsx --print --prompt "summarize the test failures"
```

`CLAUDE_CODE_UNATTENDED_RETRY=1` switches retry to infinite (default 10) for unattended CI runs.

## Sessions

JSONL append-only, one line per event:

```
~/.freecode/projects/<encoded-cwd>/<session-id>.jsonl
```

`/resume` (no id) lists recent sessions; `/resume <id>` reconnects. Messages, tool calls, tool results, thinking, and system notes are all captured.

## Errors

Provider errors are mapped to friendly messages:

- `Local provider not running — please start Ollama`
- `Local provider not running — please start LM Studio`
- `Model not found — use /model to switch`
- `Invalid API key — check the key for <provider>`
- `Invalid NVIDIA API key — get one at build.nvidia.com (free tier available)`
- `Rate limited by <provider> — retrying with backoff`
- `Context window exceeded — auto-compacting`

Retries use exponential backoff with jitter. `CLAUDE_DEBUG=1` writes verbose logs to stderr.

## Status

This is a working v0.1. See `SPEC.md` for the full design.

**Working:** 9 providers (Anthropic, OpenAI-compat covers OpenAI/GitHub Models/LM Studio/NVIDIA NIM, Gemini, mock; Bedrock/Vertex/Ollama fall through to mock), settings priority + JSONC + hot-reload, sessions + /new + /resume, 8 tools, permission engine, denylist, REPL with status bar + input + footer + slash commands + keybinds, dark/light theme with fixed RGB constants, agent loop with streaming + tool exec + retry, friendly error mapping, --print headless mode, 17 unit tests.

**Deferred:** gRPC proto + bidirectional stream (current `serve` is a port-binding placeholder), Bedrock + Vertex + Ollama real providers (mock fallback for now), spinner shimmer component (TUI shows static indicator), auto-compact invocation wired to provider, prompt cache markers in provider requests.
