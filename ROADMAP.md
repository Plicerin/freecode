# freecode Roadmap — parity vs Claude Code

**Benchmark:** Anthropic Claude Code v2.1.x (feature surface from its public CHANGELOG).
**Method:** diff of Claude Code's authoritative feature surface against freecode's *verified* current state. The official repo is docs/changelog only, so this tracks features, not source.
**Date:** 2026-06-04

Pursued in stages. "Done" is per-item and checkable — never a single blanket "are we at parity" gate.

---

## ✅ Already at parity
Agent loop + streaming · tools: Bash, Read/Write/Edit, Glob, Grep, ViewImage, WebFetch, WebSearch, MCP · 3-mode permissions · MCP client · plan mode · headless `-p/--print` · image input · markdown + syntax highlighting · git/PR workflow (`/commit` `/diff` `/review` `/branch` `/commit-push-pr` `/issue` `/pr-comments` `/security-review` `/autofix-pr`) · `/doctor` `/config` `/cost` `/compact` `/resume` `/rename` `/model` `/provider` `/mcp` `/verify`

---

## Tier A — architectural (defines "modern Claude Code"; freecode lacks the design)
- [~] **Subagents** — foundation shipped; library/isolation pending.
  - [x] `Agent` tool — dispatch an autonomous sub-agent, returns its final message; recursion-safe by construction (sub-agent gets no Agent tool); wired into REPL + headless; tested.
  - [x] `/agents` — lists built-in + user/project agent types; project agents from `.freecode/agents/*.md`
  - [x] subagent types — built-ins `general`/`explore`/`code-reviewer` (own prompts + tool allowlists); `Agent` tool `subagent_type` param; typed sub-agents restricted to their allowlist; tested
  - [ ] worktree isolation for parallel file-mutating sub-agents
  - [ ] background sub-agents + completion notifications
  - [ ] REPL UI for live sub-agent progress (today only the final report surfaces)
- [~] **Skills** — foundation shipped; self-authoring pending.
  - [x] discovery (`.freecode/skills/<name>.md` or `<name>/SKILL.md`, frontmatter `description` = trigger), prompt index (names/triggers only), `Skill` tool (on-demand body load = context-fork), `/skills`. Auto-reload (loaded per turn).
  - [ ] **self-authoring** — freecode proposes a skill when it detects a reusable procedure; propose-and-confirm, never silent (freecode-original / identity feature, not parity)
  - [ ] `/reload-skills` (currently moot — skills load fresh each turn)
- [~] **Plugins + marketplace** — local plugins + install-from-source shipped; central registry pending.
  - [x] plugin = `.freecode/plugins/<name>/` with `plugin.json` + any of `commands/`/`agents/`/`skills/`/`workflows/`; the existing resolvers scan enabled plugins (precedence user < plugin < project); `/plugins` lists + enable/disable (persisted). Tested incl. a plugin's skill flowing through `resolveSkills`.
  - [x] `/plugins install <git-url|local-path>` + `/plugins uninstall <name>` — clone/copy a bundle into the user plugins dir, staged + validated + atomically moved into place, refuses to clobber; reports the plugin's contributions. No code runs at install time. Tested (local path, name derivation, clobber guard, no-manifest reject, uninstall).
  - [ ] central registry / marketplace index (`/plugins search`, discovery, ratings) — the deferred heavy half
  - [ ] versioning + `/plugins update`; plugin-contributed MCP servers; live reload of plugin *commands* (today needs a restart)
- [x] **Workflows** — declarative engine + dynamic composition + streaming shipped.
  - [x] declarative file-based workflows (`.freecode/workflows/<name>.json`): ordered stages (barrier between), tasks parallel within a stage, each task dispatches a sub-agent (optional type), `{{input}}`/`{{previous}}` interpolation. `/workflows` lists + runs. Ships an example `review` (parallel correctness+security → synthesis).
  - [x] **dynamic** orchestration / `/ultraplan <task>` — the model composes a workflow on the fly (emits a declarative spec validated by the same Zod schema, runs through the same engine); plan shown before running, result threaded into the conversation, abortable.
  - [x] progress streaming — `runWorkflow` emits `stage_start`/`task_done`/`stage_done`; `/workflows` + `/ultraplan` render per-task ticks live (a slow task no longer hides its faster siblings).
  - [ ] concurrency cap for very wide fan-outs; streaming a sub-agent's *interior* output (today: per-task ticks + final result)
- [ ] **Background sessions + daemon** — `/bg`, `--bg`, detach, `claude agents`, reaping, `daemon status`.

## Tier B — substantial but lean-feasible
- [ ] **Richer hooks** — add SessionStart/End, UserPromptSubmit, Notification, SubagentStop, PreCompact + rich outputs (`additionalContext`, `sessionTitle`, `reloadSkills`). *(freecode has 3: Pre/PostToolUse, Stop.)*
- [ ] **Scheduling/automation** — `/schedule` (cron), `/loop`, `/goal`.
- [ ] **Granular permissions** — per-pattern Bash/path/domain allow-deny rules, `keybindings.json`, managed/org settings, sandbox.
- [ ] **`AskUserQuestion` tool** — interactive multiple-choice prompting.
- [ ] **Session depth** — prompt history (Ctrl+R), transcript view (Ctrl+O / `/expand`), `/clear`, `/status`, **session-fork `/branch`** (distinct from the git `/branch` already shipped), `/color`/`/theme`.
- [ ] **LSP integration** — `workspaceSymbol`, language-server ops.

## Tier C — observability/polish (cheap, good for momentum)
- [ ] `/usage` · `/insights` · `/status` · `/effort` · `/fast` · `/feedback` · `/release-notes`
- [ ] TUI niceties — thinking-block collapse, tool-output collapse, word-level diff rendering, OSC-8 hyperlinks, copy-on-select, jump-to-bottom

## Tier D — out of scope for a lean CLI (named and set aside)
IDE extensions (VS Code/JetBrains) · voice mode · Chrome connector · Remote Control/mobile · Desktop app · Agent SDK (Node/Python libs) · auto-update · OTEL telemetry · enterprise managed settings · multi-platform sandbox (bwrap/socat)

---

## freecode's net-new (Claude Code does NOT have these — keep them)
Verify gate · provenance ledger · `/log` activity audit · secret redaction across tool output *and* logs · repeated-failure circuit-breaker · perf ghost (`/bench`) · encrypted key vault · multi-provider breadth (Anthropic + OpenAI-compat family + Gemini + GitHub Models + Ollama/LM Studio/NIM) vs Claude Code's Anthropic + Bedrock/Vertex

---

## Shipped
- **2026-06-04 — Stage 1: Git/PR workflow** (`src/commands/git-workflow.ts`, tested): `/branch`, `/commit-push-pr`, `/issue`, `/pr-comments`, `/security-review`, `/autofix-pr`. Slash surface 22 → 28.
- **2026-06-04 — Sub-agents foundation** (`src/agent/subagent.ts`, `src/tools/agent.ts`, tested): the `Agent` tool — orchestrator dispatches an autonomous sub-agent (fresh context, same tools minus Agent, verify off), final message returned as the tool result. Recursion-safe; wired into REPL (non-plan-mode) + headless. 3 tests (final-message semantics, dispatch, recursion guard).
- **2026-06-05 — Subagent types + `/agents`** (`src/agent/agent-types.ts`, tested): built-in types `general`/`explore`/`code-reviewer` with specialization prompts + tool allowlists; user/project agents from `.freecode/agents/*.md` (frontmatter `description`/`tools`), project overrides built-in; `Agent` tool gains `subagent_type` (validated, types listed in its description); `/agents` command. 4 tests (resolution, project override, allowlist enforcement, unknown-type rejection).
- **2026-06-05 — Skills foundation** (`src/agent/skills.ts`, `src/tools/skill.ts`, tested): `.freecode/skills/<name>.md` or `<name>/SKILL.md` (frontmatter `description` = trigger, body = instructions); compact index injected into the system prompt (names/triggers only); `Skill` tool loads a skill's full body on demand (context-fork) with `$ARGUMENTS` expansion; user+project resolution (project wins); `/skills` command. 6 tests. Built so the self-authoring layer just writes into the same dir. Ships a `commit-message` (Conventional Commits) project skill.
- **2026-06-05 — Plugins (local)** (`src/plugins.ts`, tested): plugin = `.freecode/plugins/<name>/` (`plugin.json` + `commands`/`agents`/`skills`/`workflows` subdirs); the four existing resolvers scan enabled plugins (precedence user < plugin < project); enable/disable persisted to `plugins-state.json`; `/plugins` command. Marketplace/install deferred. 4 tests.
- **2026-06-05 — Workflows (declarative)** (`src/agent/workflow.ts`, tested): `.freecode/workflows/<name>.json` — ordered stages (barrier between), parallel tasks within a stage, each dispatches a sub-agent (optional type), `{{input}}`/`{{previous}}` interpolation for fan-out → synthesis; `/workflows` lists + runs (per-stage progress, abortable). Ships an example `review` workflow. 3 tests (discovery/validation, shipped-workflow validity, engine barrier+parallel+interpolation).
- **2026-06-05 — Plugin install/uninstall** (`src/plugins.ts`, tested): `/plugins install <git-url|local-path>` clones (git, depth 1) or copies a bundle into the user plugins dir — staged in a hidden temp dir on the same volume, manifest-validated, then atomically `rename`d into place as `<name>`; refuses to clobber an existing plugin; reports contributions per kind. `/plugins uninstall <name>` removes it + clears any stale disabled flag. `/plugin` accepted as a singular alias. Install moves files only — nothing executes. `resolvePlugins` now skips hidden dirs (staging/.git). 6 tests (local install, name derivation, clobber guard, no-manifest reject, uninstall, uninstall-missing).
- **2026-06-05 — Dynamic workflows + streaming** (`src/agent/workflow.ts`, tested): `composeWorkflow()` asks the model to decompose a task into a declarative workflow spec (stages → parallel sub-agent tasks, agent types, `{{input}}`/`{{previous}}`), tolerant JSON extraction (fences/prose), validated by the same `WorkflowFileSchema`, run through the same engine (`source: "dynamic"`). `/ultraplan <task>` composes → shows the plan → runs it (abortable, result threaded into the conversation + session). `runWorkflow` now emits a `WorkflowEvent` stream (`stage_start`/`task_done`/`stage_done`); both `/workflows` and `/ultraplan` render live per-task progress. 5 new tests (clean parse, fence/prose tolerance, no-JSON reject, schema reject, event ordering).
- **2026-06-05 — Web tools require approval** (`src/tools/web-search.ts`, `src/tools/web-fetch.ts`): both were `permission: "safe"` (auto-run) and fired on stray text fragments; now `permission: "confirm"` with tightened descriptions + a strict web-tool policy in the system prompt (`src/tools/registry.ts`).
