// Minimal Honcho v3 client — fetch-based, no SDK dependency (matches the
// hand-rolled provider HTTP in openai-compat.ts). Honcho is freecode's shared,
// cross-session memory backend: project-scoped peers accumulate derived
// representations (Honcho's deriver worker builds them in the background), which
// freecode reads at session start so a new session opens with what earlier ones
// learned instead of from scratch.
//
// Each method throws on a transport/HTTP error; the MemoryStore layered above
// swallows those so a slow or absent Honcho can never block or break a coding
// session. freecode lives in its OWN workspace, isolated from anything else in
// the same Honcho instance (get-or-create is idempotent and non-destructive).

export interface HonchoClientOptions {
  /** Base URL WITHOUT the /v3 suffix, e.g. http://host:8100 */
  baseUrl: string;
  /** freecode's isolated workspace id. */
  workspace: string;
  /** Optional bearer token (the self-hosted default has auth off). */
  apiKey?: string;
  timeoutMs?: number;
}

export interface HonchoMessage {
  content: string;
  peer_id: string;
  metadata?: Record<string, unknown>;
}

export interface RepresentationOptions {
  sessionId?: string;
  target?: string;
  /** Curate the representation around semantic search of the peer's history. */
  searchQuery?: string;
  searchTopK?: number;
  maxConclusions?: number;
}

// Honcho MessageCreate.content maxLength; MessageBatchCreate maxItems.
const MAX_CONTENT = 25_000;
const MAX_BATCH = 100;

export class HonchoClient {
  private readonly root: string; // …/v3
  private readonly ws: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(opts: HonchoClientOptions) {
    this.root = opts.baseUrl.replace(/\/+$/, "") + "/v3";
    this.ws = opts.workspace;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const resp = await fetch(this.root + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Honcho ${method} ${path} -> ${resp.status} ${text.slice(0, 200)}`);
    }
    if (resp.status === 204) return undefined as T;
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return undefined as T;
    return (await resp.json()) as T;
  }

  /** True if the API answers /health. Never throws. */
  async ping(): Promise<boolean> {
    try {
      const base = this.root.replace(/\/v3$/, "");
      const resp = await fetch(base + "/health", { cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Get-or-create freecode's workspace (idempotent, non-destructive). */
  ensureWorkspace(): Promise<unknown> {
    return this.req("POST", "/workspaces", { id: this.ws, metadata: { app: "freecode" } });
  }

  ensurePeer(id: string): Promise<unknown> {
    return this.req("POST", `/workspaces/${enc(this.ws)}/peers`, { id });
  }

  ensureSession(id: string, peers: string[]): Promise<unknown> {
    const peerMap: Record<string, Record<string, never>> = {};
    for (const p of peers) peerMap[p] = {};
    return this.req("POST", `/workspaces/${enc(this.ws)}/sessions`, { id, peers: peerMap });
  }

  /** Ingest turns into a session (batched to Honcho's 100/req limit, content capped). */
  async addMessages(sessionId: string, messages: HonchoMessage[]): Promise<void> {
    const clean = messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ ...m, content: capContent(m.content) }));
    for (let i = 0; i < clean.length; i += MAX_BATCH) {
      await this.req("POST", `/workspaces/${enc(this.ws)}/sessions/${enc(sessionId)}/messages`, {
        messages: clean.slice(i, i + MAX_BATCH),
      });
    }
  }

  /** The deriver-built representation of a peer (the durable memory). "" if none yet. */
  async getRepresentation(peerId: string, opts: RepresentationOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {};
    if (opts.sessionId) body.session_id = opts.sessionId;
    if (opts.target) body.target = opts.target;
    if (opts.searchQuery) {
      body.search_query = opts.searchQuery;
      if (opts.searchTopK) body.search_top_k = opts.searchTopK;
      if (opts.maxConclusions) body.max_conclusions = opts.maxConclusions;
    }
    const r = await this.req<{ representation?: string }>(
      "POST",
      `/workspaces/${enc(this.ws)}/peers/${enc(peerId)}/representation`,
      body,
    );
    return r?.representation ?? "";
  }

  /** A compact bullet card for a peer (identity summary). [] if none yet. */
  async getPeerCard(peerId: string): Promise<string[]> {
    const r = await this.req<{ peer_card?: string[] | null }>(
      "GET",
      `/workspaces/${enc(this.ws)}/peers/${enc(peerId)}/card`,
    );
    return r?.peer_card ?? [];
  }

  /** Dialectic query: ask a natural-language question about a peer. "" if no answer. */
  async chat(
    peerId: string,
    query: string,
    opts: { target?: string; sessionId?: string; reasoningLevel?: string } = {},
  ): Promise<string> {
    const body: Record<string, unknown> = { query };
    if (opts.target) body.target = opts.target;
    if (opts.sessionId) body.session_id = opts.sessionId;
    if (opts.reasoningLevel) body.reasoning_level = opts.reasoningLevel;
    const r = await this.req<{ content?: string | null }>(
      "POST",
      `/workspaces/${enc(this.ws)}/peers/${enc(peerId)}/chat`,
      body,
    );
    return r?.content ?? "";
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/** Keep a message under Honcho's content cap, preserving head + tail. */
function capContent(s: string): string {
  if (s.length <= MAX_CONTENT) return s;
  const marker = "\n...[truncated]...\n";
  const head = Math.floor((MAX_CONTENT - marker.length) * 0.7);
  const tail = MAX_CONTENT - marker.length - head;
  return s.slice(0, head) + marker + s.slice(s.length - tail);
}
