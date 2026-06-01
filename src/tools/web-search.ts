import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(20).optional(),
  recencyDays: z.number().int().positive().optional(),
  backend: z.enum(["duckduckgo", "tavily", "exa", "firecrawl"]).optional(),
});

export interface WebSearchOptions {
  tavilyKey?: string;
  exaKey?: string;
  firecrawlKey?: string;
  defaultBackend?: "duckduckgo" | "tavily" | "exa" | "firecrawl";
}

function pickBackend(opts: WebSearchOptions, requested?: string): "duckduckgo" | "tavily" | "exa" | "firecrawl" {
  if (requested) return requested as "duckduckgo" | "tavily" | "exa" | "firecrawl";
  if (opts.tavilyKey) return "tavily";
  if (opts.exaKey) return "exa";
  if (opts.firecrawlKey) return "firecrawl";
  return opts.defaultBackend ?? "duckduckgo";
}

export function createWebSearchTool(opts: WebSearchOptions = {}): Tool<z.infer<typeof ArgsSchema>> {
  return {
    name: "WebSearch",
    description: "Search the public web. Default backend is DuckDuckGo (no key). Override with backend='tavily'/'exa'/'firecrawl' if those keys are set.",
    schema: ArgsSchema,
    permission: "safe",
    async run(args) {
      const backend = pickBackend(opts, args.backend);
      try {
        if (backend === "duckduckgo") {
          return await duckduckgo(args.query, args.maxResults ?? 5);
        }
        if (backend === "tavily") {
          if (!opts.tavilyKey) return { ok: false, output: "", error: "TAVILY_API_KEY not set" };
          return await tavily(args.query, opts.tavilyKey, args.maxResults ?? 5);
        }
        if (backend === "exa") {
          if (!opts.exaKey) return { ok: false, output: "", error: "EXA_API_KEY not set" };
          return await exa(args.query, opts.exaKey, args.maxResults ?? 5);
        }
        if (backend === "firecrawl") {
          if (!opts.firecrawlKey) return { ok: false, output: "", error: "FIRECRAWL_API_KEY not set" };
          return await firecrawl(args.query, opts.firecrawlKey, args.maxResults ?? 5);
        }
        return { ok: false, output: "", error: `Unknown backend: ${backend}` };
      } catch (err) {
        return { ok: false, output: "", error: `WebSearch failed: ${String(err)}` };
      }
    },
  };
}

type SearchResult = { ok: boolean; output: string; error?: string; metadata?: Record<string, unknown> };

interface SearchHit { title: string; url: string; snippet: string; }

async function duckduckgo(query: string, max: number): Promise<SearchResult> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { "user-agent": "freecode/0.1 (+https://example.invalid)" } });
  if (!resp.ok) return { ok: false, output: "", error: `DuckDuckGo HTTP ${resp.status}` };
  const html = await resp.text();
  const hits = extractDDG(html).slice(0, max);
  if (hits.length === 0) return { ok: true, output: "(no results)", metadata: { backend: "duckduckgo" } };
  const formatted = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n\n");
  return { ok: true, output: formatted, metadata: { backend: "duckduckgo", count: hits.length } };
}

function extractDDG(html: string): SearchHit[] {
  const results: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = decodeHtml(m[1] ?? "");
    const title = stripTags(m[2] ?? "").trim();
    const snippet = stripTags(m[3] ?? "").trim();
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function decodeHtml(s: string): string {
  return stripTags(s);
}

async function tavily(query: string, key: string, max: number): Promise<SearchResult> {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: max }),
  });
  if (!resp.ok) return { ok: false, output: "", error: `Tavily HTTP ${resp.status}` };
  const data = await resp.json() as { results?: Array<{ title: string; url: string; content: string }> };
  const results = (data.results ?? []).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`).join("\n\n");
  return { ok: true, output: results || "(no results)", metadata: { backend: "tavily" } };
}

async function exa(query: string, key: string, max: number): Promise<SearchResult> {
  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: max }),
  });
  if (!resp.ok) return { ok: false, output: "", error: `Exa HTTP ${resp.status}` };
  const data = await resp.json() as { results?: Array<{ title: string; url: string; text?: string }> };
  const results = (data.results ?? []).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.text ?? ""}`).join("\n\n");
  return { ok: true, output: results || "(no results)", metadata: { backend: "exa" } };
}

async function firecrawl(query: string, key: string, max: number): Promise<SearchResult> {
  const resp = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, limit: max }),
  });
  if (!resp.ok) return { ok: false, output: "", error: `Firecrawl HTTP ${resp.status}` };
  const data = await resp.json() as { data?: Array<{ title?: string; url: string; description?: string }> };
  const results = (data.data ?? []).map((r, i) => `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url}\n   ${r.description ?? ""}`).join("\n\n");
  return { ok: true, output: results || "(no results)", metadata: { backend: "firecrawl" } };
}
