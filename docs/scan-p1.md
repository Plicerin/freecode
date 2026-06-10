# `/scan` — local model-endpoint discovery (P1 design note)

**Status:** design note, not implemented. Phase 1 of the *Local-endpoint discovery*
roadmap item (Tier B). Prerequisite for Berzerker (Tier X).
**Date:** 2026-06-10

---

## Why P1 is "just list"

P1 ships a manual `/scan` command that **discovers and prints** reachable model
endpoints — LAN + Tailscale — with kind, model(s), and loaded context. It does
**not** pick, switch provider, write baseURL, or touch session memory. Those are
P2 (auto-trigger on local-provider select) and P3 (picker + memory wiring).

The point of stopping at "list" is to **de-risk the scanner in isolation**: the
hard, novel parts here are subnet derivation, Tailscale enumeration, and a fast
bounded sweep with sane timeouts. Get those observably right before entangling
them with the picker/config code. (Same instinct as `freecode probe`: make the
behavior observable first.)

## What the user sees

```
/scan
Scanning 192.168.1.0/24 (254 hosts) + 6 Tailscale peers …
  ✓ 192.168.1.205:8080     llama-server   qwen2.5-coder-32b-instruct      256K ctx   12ms
  ✓ 192.168.1.181:11434    ollama         llama3.2:latest, qwen2.5:7b     ctx n/a     8ms
  ✓ desktop-…tail989c2…:443 llama-server   (model id)                      256K ctx   41ms
  3 endpoints · 257 hosts unreachable · 4.2s
  note: ollama doesn't report loaded context via /api/tags (shown as n/a)
Connect:  /provider <kind>  then  /model    (one-tap connect lands in P3)
```

Honesty rules (carry the "evidence over confidence" line):
- Report **scanned / found / unreachable** counts and elapsed time.
- Show `ctx n/a` for ollama rather than guessing.
- If a source was skipped (no `tailscale` CLI; mask wider than /24), **say so** in
  a note — never a silent partial sweep that reads as "this is everything".

## Data model

```ts
interface Endpoint {
  host: string;                  // ip or DNS name
  port: number;
  kind: "lmstudio" | "llama-server" | "ollama";
  baseUrl: string;               // the /v1 URL freecode would use to connect
  models: string[];              // loaded/available model ids (may be empty)
  contextLength: number | null;  // per-slot loaded ctx if known, else null
  source: "lan" | "tailscale" | "local";
  rttMs: number;
}
```

## Candidate generation (what to probe)

Union of two sources, deduped by `host:port`:

1. **LAN /24** — from `os.networkInterfaces()`: for each non-internal IPv4
   interface, read `.cidr` / `.netmask`. Enumerate `.1`–`.254` of that /24.
   **Guard:** only enumerate a `/24` or smaller. If the mask is wider (e.g. a
   `/16` = 65k hosts), do **not** sweep it blind — scan just the local /24 around
   the host address, and require an explicit `/scan <cidr>` to go wider.
2. **Tailscale peers** — shell out to `tailscale status --json`; read `Self` +
   each `Peer{}`'s `TailscaleIPs[0]` and `DNSName`. Skip cleanly (empty + a note)
   if the CLI is missing or errors. **This half is non-optional for our setup:**
   the remote llama-server we use today is `*.tail989c2.ts.net`, a Tailscale node
   that a LAN /24 sweep would never see.

Ports tried per host (port already implies the likely kind):

| Port  | Kind         | Probe endpoint        | Models + ctx source                    |
|-------|--------------|-----------------------|----------------------------------------|
| 1234  | lmstudio     | `GET /api/v0/models`  | `parseLoadedLmStudioModels` (ids + ctx)|
| 8080  | llama-server | `GET /props`          | ctx ← `parseLlamaServerContext`; model id ← `GET /v1/models` |
| 11434 | ollama       | `GET /api/tags`       | `{models:[{name}]}` → names; ctx = null |

Open decision: Tailscale endpoints often answer over **HTTPS / non-standard
ports** (the ts.net remote is on 443). P1's fixed port list will miss those — so
Tailscale candidates should *also* try `443` + the OpenAI-compat `/v1/models`
path, or accept that non-standard ports need manual entry. See "Open decisions".

## Probe (per `host:port`)

One GET per `(host, port)` using the port→kind mapping above (cheaper than
`detectServerKind`, which fires 3 sequential probes per call — 3× the sockets on a
762-host sweep). On a hit, do the kind-specific model/ctx fetch.

- **Timeout:** `AbortSignal.timeout(400)`. The existing `probeOk` uses 1500ms —
  fine for a single known endpoint, too slow for a 762-host sweep. Refused ports
  fail instantly; the only slow path is a host that's up but firewalled on that
  port, which the 400ms ceiling bounds.
- **Concurrency:** `mapWithConcurrency(candidates, 64, probe)` (already in
  `src/utils/concurrency.ts`, order-preserving). 762 candidates / 64 ≈ 12 waves ×
  ~0.4s worst case ≈ a ~5s ceiling; far faster in practice.
- **Never throws:** a probe returns `Endpoint | null`; `.filter(Boolean)` after.

## Module layout

New: `src/providers/endpoint-scan.ts`
- `localCidrs(): { cidr: string; hostCount: number }[]` — from
  `os.networkInterfaces()`; skips internal + IPv6; guarded to ≤/24.
- `enumerateHosts(cidr: string): string[]` — **pure**, unit-tested.
- `tailscalePeers(): Promise<string[]>` — spawns `tailscale status --json`; `[]`
  if absent/errors (thin impure shell).
- `PORT_KIND: Record<number, Endpoint["kind"]>`
- `probeEndpoint(host, port, timeoutMs, fetchFn?): Promise<Endpoint | null>` —
  one GET + kind-specific parse. `fetchFn` injectable for tests.
- `scanEndpoints(opts?): Promise<{ endpoints: Endpoint[]; scanned: number; elapsedMs: number; notes: string[] }>` —
  candidates → `mapWithConcurrency` → filter → dedupe → sort.

Reused from `src/providers/local-context.ts`: `parseLoadedLmStudioModels`,
`parseLlamaServerContext`. (No need to export the private `probeOk` — the sweep
gets its own shorter-timeout probe.)

`src/commands/repl.tsx`:
- add `"/scan"` to `SLASH_COMMANDS` (line ~78) and a one-liner in
  `SLASH_DESCRIPTIONS` (~line 113);
- add `case "/scan":` to the dispatch `switch`: print a "Scanning …" line, await
  `scanEndpoints()`, render the list + notes via `setMessages`. (Progressive
  "found as you go" via an `onFound` callback is a nicety — defer to P2; batch
  print is fine for P1.)

## Guardrails / etiquette

- **Triggered only.** `/scan` is explicit; it never auto-runs at launch or under
  `-p`/headless/`bg`. (A subnet sweep looks like a port scan to an IDS on a shared
  network. Our home lab is fine; don't make it a default behavior.)
- **≤/24 enumeration cap**, explicit `/scan <cidr>` to widen.
- **Read-only:** unauthenticated GETs to model-server status endpoints only — no
  bodies, no auth attempts, nothing leaves the box.
- Include loopback / own host so a locally-running server shows up (`source: "local"`).

## Tests (P1 — pure / injectable, no live network in CI)

- `enumerateHosts`: `/24` → 254 hosts, correct first/last; refuses `/16`.
- `localCidrs`: parse a mocked `networkInterfaces()` (skips internal + IPv6).
- `probeEndpoint`: feed canned JSON bodies through an injected `fetchFn` →
  correct `Endpoint` per kind; non-200 / garbage → `null`.
- `tailscalePeers`: parse a canned `tailscale status --json` fixture → IPs;
  missing CLI → `[]`.
- dedupe: same host seen via LAN + Tailscale collapses to one entry.
- `scanEndpoints`: inject the probe fn → ordering preserved, nulls filtered,
  `notes` populated when a source is skipped.
- The live sweep is runtime-only (like the OAuth browser flows): unit-test the
  pure pieces, smoke-verify live against the lab.

## Open decisions to settle before coding

1. **Tailscale port set.** The ts.net remote answers on 443 over HTTPS, not 8080.
   Either probe `443` + `/v1/models` for Tailscale candidates, or document that
   non-standard ports need manual entry. (Leaning: try 443 for Tailscale peers.)
2. **Non-standard local llama.cpp ports.** A llama-server on `:9000` won't be
   found by a fixed-port sweep. Accept `/scan --ports a,b,c`, or rely on manual
   entry. (Leaning: fixed ports for P1, `--ports` later.)
3. **Batch vs progressive output.** Batch-print at end is simplest for P1;
   progressive (`onFound`) feels better at ~5s. (Leaning: batch in P1, progressive
   in P2 when it's wired to the picker anyway.)

## Explicitly out of P1

Picker UI, provider/baseURL switch, session-memory writes, auto-trigger on
`/provider`, retiring the `LLAMA_SERVER_HOST` override. All P2/P3.
