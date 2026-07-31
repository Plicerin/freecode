# New Enhancement Plan

## Product direction

Do not pursue command-count parity with OpenClaude. Build a dependable local and Tailscale-capable agent service around freecode's strongest differentiator: verification-first execution with observable evidence.

The next coherent milestone is a real authenticated streaming backend shared by the REPL, headless mode, background jobs, and future remote clients.

## P0 — Replace `serve` with a real agent service

Use HTTP plus Server-Sent Events for the first release. It is simpler to consume from desktop, web, CLI, and Tailscale clients than gRPC while still supporting structured streaming.

Minimum API:

- `GET /health/live` — confirm the process is running.
- `GET /health/ready` — confirm the provider is reachable and the configured model is available.
- `GET /v1/models` — list usable models.
- `POST /v1/sessions` — create a session.
- `GET /v1/sessions` — list resumable sessions.
- `POST /v1/sessions/:id/messages` — start an agent turn and return an SSE stream.
- `POST /v1/runs/:id/approvals` — answer a pending tool approval.
- `POST /v1/runs/:id/cancel` — cancel an active turn.
- `GET /v1/jobs/:id` — inspect background work.

The event stream must represent text, thinking, tool calls, approval requests, tool results, verification, usage, errors, and terminal completion.

### Definition of done

- A client can create or resume a session and stream a complete agent turn.
- Tool approvals can be allowed or denied without blocking the server process.
- Cancellation stops provider streaming and in-flight tools.
- Liveness and readiness report different states.
- The service uses the same agent behavior and safety controls as the REPL.
- End-to-end tests cover the complete request, tool, approval, verification, and completion flow.

## P0 — Extract a shared runtime

Create a UI-independent runtime used by:

- REPL
- Headless execution
- Background jobs
- HTTP/SSE server

The runtime should own session loading, AgentLoop construction, provider access, tools, permissions, hooks, memory, verification, cancellation, and event emission. UI surfaces should translate runtime events rather than implementing their own agent behavior.

Do not build a separate server-specific loop; duplicated loops will drift in permissions, safety, recovery, and verification behavior.

## P0 — Secure Tailscale deployment

Preferred deployment:

1. Bind freecode to `127.0.0.1` by default.
2. Publish it through `tailscale serve` when tailnet access is required.
3. Keep provider and discovery connections to remote llama-servers on their existing direct or MagicDNS paths.

Direct non-loopback binding must:

- Require explicit `--host` configuration.
- Require bearer-token authentication.
- Refuse unauthenticated `0.0.0.0` or LAN binding.
- Use an explicit CORS allowlist rather than `*`.
- Avoid logging authorization headers, provider keys, prompts, or tool secrets.

WebFetch's SSRF restrictions must remain isolated from provider, discovery, and backend networking.

## P0 — Make `/doctor` diagnose real failures

Extend diagnostics to test each connectivity layer independently:

1. DNS or MagicDNS resolution
2. TCP connection
3. TLS negotiation and certificate validation
4. Provider authentication
5. Model-list endpoint
6. Configured-model availability
7. Optional one-token streaming smoke test
8. Backend liveness and readiness
9. Tailscale status and discovered peers for local providers

Add `freecode doctor --json` so the CLI, app, support tooling, and future SDK use the same diagnostic results.

Diagnostics must be bounded by short timeouts and must clearly distinguish configuration errors, DNS failures, connection refusal, authentication failure, unavailable models, and stalled generation.

## P1 — Define a versioned event protocol

Stabilize the runtime event contract before publishing an SDK or remote client.

Example envelope:

```json
{
  "version": 1,
  "sessionId": "session-id",
  "runId": "run-id",
  "sequence": 12,
  "timestamp": "2026-07-31T00:00:00.000Z",
  "type": "tool_call",
  "data": {}
}
```

Requirements:

- Monotonically increasing sequence numbers per run.
- Stable session and run identifiers.
- Explicit terminal events.
- Defined reconnect and replay behavior.
- Backward-compatible schema versioning.
- The same event model for SSE and `--output stream-json`.

## P1 — Stabilize automation interfaces

- Add `--output json` for a final machine-readable result.
- Add `--output stream-json` for versioned runtime events.
- Add tool allowlists and denylists.
- Add turn, token, time, and optional cost budgets.
- Define deterministic exit codes for success, verification failure, provider failure, denial, timeout, and cancellation.
- Make background jobs resumable and observable through both CLI and server APIs.

## P1 — Backend contract and reliability tests

Add end-to-end coverage for:

- A complete mock-provider turn.
- Streaming text and reasoning.
- Sequential and parallel tool calls.
- Approval allow and deny paths.
- Cancellation during provider streaming and tool execution.
- Client disconnect and reconnect.
- Session persistence and resume.
- Provider timeout and mid-stream failure.
- Graceful server shutdown during an active run.
- Tailscale-style provider hostnames.
- Authentication, CORS, and non-loopback binding policy.
- Readiness transitions when a provider becomes available or unavailable.

## P1 — Complete transport and session fundamentals

- Add MCP Streamable HTTP while retaining stdio.
- Add session export with a documented portable format.
- Add conversation summary, rewind, branch, and replay.
- Add a settings and persisted-state migration framework.
- Add configurable keybindings after command and session contracts stabilize.

## P2 — Build on the stable backend

After the runtime and event contracts are stable:

1. Publish a small TypeScript SDK generated from or validated against the backend contract.
2. Build remote and desktop clients.
3. Add VS Code integration and LSP diagnostics.
4. Add plugin compatibility metadata, trust policy, updates, and dependency resolution.
5. Add GitHub App and Slack integrations.
6. Implement native Bedrock and Vertex providers only when user demand justifies their maintenance cost.

## Explicitly deferred

- Recreating every OpenClaude slash command.
- Decorative TUI breadth before backend reliability.
- A plugin marketplace before plugin trust and versioning exist.
- Mobile UI before the server protocol is authenticated and stable.
- gRPC unless a typed bidirectional protocol or OpenClaude compatibility becomes a concrete requirement.
- Additional provider logos before current providers have strong health diagnostics.

## Recommended implementation sequence

1. Shared runtime and versioned internal events.
2. Liveness, readiness, provider diagnostics, and `/doctor --json`.
3. Session and streaming-turn HTTP/SSE endpoints.
4. Approval, cancellation, and background-job endpoints.
5. Authentication, Tailscale deployment policy, and CORS restrictions.
6. Backend contract and failure-mode tests.
7. JSON and stream-JSON headless output.
8. Session rewind/export/replay and MCP HTTP.
9. SDK, remote clients, and IDE/LSP integrations.

This order fixes the backend-availability problem at its root and creates a stable foundation for every later platform enhancement.
