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

> **Note:** AWS Bedrock and Google Vertex are listed for selector completeness but are **not implemented yet** — selecting them returns a clear "not implemented" error rather than fake output. Use `--provider mock` for an offline, no-key demo.

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

## API key vault

On first run, freecode walks you through onboarding: pick the providers you have keys for, paste each key once, and they're stored **encrypted** — no plaintext keys in env vars or profiles, and you never enter them again.

Keys live in `~/.freecode/vault.json` (AES-256-GCM). By default the vault auto-unlocks with a per-machine device key at `~/.freecode/vault.key` (permission-locked) — zero friction, no prompt. For stronger protection, set `FREECODE_VAULT_PASSPHRASE` and the vault is keyed off that passphrase (scrypt) instead. No plaintext key ever touches disk.

Manage it anytime:
```bash
freecode auth set anthropic     # paste a key (hidden) and store it
freecode auth list              # which providers have a stored key
freecode auth remove anthropic
```

Key precedence: `CLI --api-key > .freecode-profile.json > vault > env var`.

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

## MCP servers

freecode is an MCP (Model Context Protocol) client. Declare stdio servers under `mcpServers` in `~/.freecode/settings.json` and their tools are loaded at startup and offered to the model alongside the built-ins:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." },
      "disabled": false
    }
  }
}
```

- Tools are namespaced `<server>__<tool>` to avoid collisions.
- MCP tools always require approval (permission `confirm`) — they're external code.
- A server that fails to start is reported and skipped; the rest keep working.
- `/mcp` in the REPL lists connected servers and their tools.

Currently supported transport: **stdio** (SSE/HTTP transport is planned).

## CLI flags

```text
freecode                                    # REPL
freecode --prompt "..."                     # REPL with initial prompt
freecode --print --prompt "..."             # headless one-shot
freecode --resume <session-id>              # resume a session in REPL
freecode --serve --port 50051               # gRPC server (placeholder)
freecode --provider openai --model gpt-4o   # override provider
freecode --permission-mode bypass           # skip all prompts
freecode --thinking                          # enable extended thinking / reasoning
```

## Slash commands (REPL)

| Command    | What it does                                  |
|------------|-----------------------------------------------|
| `/model`   | Show or switch model                          |
| `/new`     | Start a fresh session                         |
| `/resume`  | List sessions or resume by id                 |
| `/context` | Show token usage + cost                       |
| `/provider`| Show or switch provider                       |
| `/mcp`     | List connected MCP servers and their tools    |
| `/plan`    | Toggle read-only plan mode (propose, don't change) |
| `/help`    | List commands                                 |
| `/compact` | Force context compaction                      |

### Custom slash commands

Drop Markdown files in `./.freecode/commands/` (project) or `~/.freecode/commands/` (user) to define your own commands — the filename becomes the command name. Invoking `/<name> [args]` expands the file and sends it as a prompt.

```markdown
<!-- .freecode/commands/review.md -->
---
description: Review a file for bugs
---
Review $ARGUMENTS for correctness bugs and suggest fixes.
```

`$ARGUMENTS` is replaced with everything after the command; `$1`, `$2`, … with positional args. Project commands override same-named user ones, and they show up in `/help` and Tab-completion.

## Keyboard

`Ctrl+C` exit · `Ctrl+U` clear input · `Ctrl+T` toggle tasks sidebar · `Tab` autocomplete slash · `Enter` submit

## Tools

`Bash` · `FileRead` · `FileWrite` · `FileEdit` · `Glob` · `Grep` (ripgrep) · `WebSearch` · `WebFetch`

Bash has a denylist for `rm -rf /`, fork bombs, sudo, `mkfs`, `dd if=`, piped shell, `chmod -R 777 /`. Grep uses `rg` (ripgrep) when it's on PATH and falls back to a built-in search otherwise; both ignore `.git/`, `node_modules/`, `dist/`.

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

**Working:** real providers — Anthropic, OpenAI-compat (covers OpenAI / GitHub Models / LM Studio / NVIDIA NIM), Gemini, and **Ollama** (local, via its OpenAI-compatible API); plus an explicit `mock` provider for offline demos. Settings priority + JSONC + hot-reload, sessions + /new + /resume, 8 built-in tools + **MCP client** (stdio servers, tools loaded at startup), permission engine with interactive approval prompts (allow / allow-always / deny), denylist, REPL with banner + info box + slash commands + keybinds, dark/light theme, agent loop with streaming + tool exec + retry, **auto-compaction** when the context window fills, **per-model cost** estimation (local models free), friendly error mapping, --print headless mode, 27 unit tests.

**Not implemented yet (fail honestly — no fake output):** AWS Bedrock (needs SigV4 signing) and Google Vertex (needs service-account auth) return a clear "not implemented" error. Also deferred: gRPC bidirectional stream (`serve` is a port-binding placeholder), spinner shimmer component, prompt-cache markers in provider requests.
