# freecode vs OpenClaude — Feature Parity Audit (true diff)

**Date:** 2026-06-04
**OpenClaude:** `Gitlawb/openclaude` v0.16.1 (cloned and inspected)
**Method:** direct comparison of both codebases — command surface, subsystems, providers.

---

## Verdict: freecode is NOT at feature parity with OpenClaude.

This isn't "near parity with a few gaps." The scale tells the story:

| | OpenClaude v0.16.1 | freecode |
|---|---|---|
| Source files | **2,485** | **60** (~40× smaller) |
| Slash commands | **119** | **16** |
| Major subsystems | plugins, integrations, hooks, bridge, SDK, remote, gRPC, agents, LSP, memory, screens, migrations, keybindings, output styles… | core loop + REPL |

freecode is a **lean reimplementation of OpenClaude's core** — the agent loop, basic tools, a handful of providers, a REPL. It covers roughly **15–20% of OpenClaude's surface**, plus its own verification-first features that OpenClaude lacks. Closing to true 1:1 parity means rebuilding a 2,485-file platform — not a fixable "gap list."

---

## What freecode is MISSING (by category)

**Slash commands — 16 vs 119.** freecode has: `/model /new /resume /rename /context /provider /plan /verify /bench /log /mcp /help /compact /about /exit`. OpenClaude additionally has ~100, including the high-value ones:
- **Git/PR workflow:** `commit`, `commit-push-pr`, `review`, `security-review`, `diff`, `pr_comments`, `branch`, `tag`, `issue`, `autofix-pr`
- **Cost/usage/insight:** `cost`, `usage`, `stats`, `insights`, `extra-usage`, `rate-limit-options`
- **Agents/automation:** `agents`, `agents-platform`, `bughunter`, `advisor`, `proactive`, `passes`, `ultraplan`
- **Config/diagnostics:** `config`, `doctor`, `env`, `permissions`, `effort`, `statusline`
- **Editor/tooling:** `ide`, `lsp`, `vim`, `chrome`, `desktop`, `mobile`, `voice`, `sandbox-toggle`
- **Auth/integrations:** `login`/`logout`, `oauth-refresh`, `onboard-github`, `install-github-app`, `install-slack-app`
- **Memory/knowledge:** `memory`, `knowledge`, `wiki`, `rewind`, `thinkback`, `session`, `export`, `share`, `summary`
- **Plugins/skills:** `plugin`, `reload-plugins`, `skills`, `output-style`, `theme`, `color`
- **Remote:** `remote-env`, `remote-setup`, `teleport`
- …plus `upgrade`, `feedback`, `doctor`, `privacy-settings`, `release-notes`, etc.

**Whole subsystems freecode has nothing equivalent to:**
- **integrations/ (83 files)** — Slack, GitHub App, IDE/VS Code extension launch integration
- **hooks/ (108 files)** — a deep hooks platform (freecode has 3 lifecycle hooks total)
- **plugins/ + reload-plugins** — a plugin architecture (freecode: none)
- **entrypoints/ SDK (23 files)** — a programmatic SDK (`openclaude/sdk`); freecode is CLI-only
- **agents / agents-platform** — sub-agents / agent orchestration; freecode is single-agent
- **remote/ + teleport + sandbox** — remote execution / sandboxed runs
- **real gRPC + proto/** — OpenClaude ships a working gRPC server; freecode's `serve` is a port-binding placeholder
- **lsp** — language-server integration; freecode has none
- **memory / memdir (9 files) / knowledge / wiki** — persistent project memory; freecode has none
- **migrations/ (11 files)** — versioned config migrations
- **keybindings/ (15 files)** — user-customizable keybindings (freecode: fixed)
- **screens/ (11 files), outputStyles, statusline, stickers, themes, voice, vim mode** — TUI breadth
- **Codex OAuth, Atomic Chat, Hicap, OpenRouter/DeepSeek/Groq/Mistral routing, "200+ models"** — provider breadth + OAuth flows

**Providers:** freecode = 7 real (Anthropic, OpenAI-compat, Gemini, GitHub Models, Ollama, LM Studio, NIM) + Bedrock/Vertex stubbed. OpenClaude = OpenAI-compat (+ OpenRouter/DeepSeek/Groq/Mistral), Gemini, GitHub Models, Codex/Codex-OAuth, Atomic Chat, Hicap, Ollama → "200+ models". (Notably freecode *adds* first-class **Anthropic**, which OpenClaude's headline doesn't emphasize.)

---

## What freecode has that OpenClaude does NOT

freecode's verification-first identity is genuinely net-new: the **verify gate + provenance ledger + earned-confidence badge**, the **encrypted key vault**, **secret redaction** across tool output and logs, the **repeated-failure circuit-breaker**, the **performance "ghost" ledger** (`/bench`), and the **activity log** (`/log`). OpenClaude has none of these. So freecode is not strictly a subset — it trades breadth for a correctness/trust focus.

---

## Honest recommendation

**"Ensure feature parity" with OpenClaude = rebuild a 2,485-file platform.** That is not a task I can or should complete autonomously, and I won't claim it done when it isn't. The realistic path is to **decide whether parity is even the goal**:

- **If freecode stays lean (recommended):** don't chase 119 commands. Pick the highest-value OpenClaude features to port and own them well. Suggested order: (1) git/PR workflow commands (`/commit`, `/review`, `/diff`), (2) `/cost` + `/usage`, (3) `/config` + `/doctor`, (4) real gRPC `serve`, (5) sub-agents. Each is a discrete, verifiable unit.
- **If true parity is the goal:** it's a multi-month port of plugins, integrations, SDK, remote, LSP, memory, OAuth, and ~100 commands — scoped as its own roadmap, not a single pass.

Either way, the answer to "what's missing" is now concrete and on the table. Tell me which direction, and I'll start closing real, verifiable units — not pretend the 40× gap is closed.
