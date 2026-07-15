import TurndownService from "turndown";
import { z } from "zod";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Tool } from "./types";

/** Is `ip` a loopback / private / link-local / unique-local address — i.e. an SSRF
 *  target WebFetch must not reach by default (cloud metadata at 169.254.169.254,
 *  localhost admin APIs, internal/Tailscale hosts). */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    const [a, b] = [p[0]!, p[1]!];
    return a === 0 || a === 127 || a === 10 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  if (v === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (a === "::1" || a === "::") return true;
    if (a.startsWith("::ffff:") && isIP(a.slice(7)) === 4) return isPrivateIp(a.slice(7)); // IPv4-mapped
    return a.startsWith("fe80") || a.startsWith("fc") || a.startsWith("fd");
  }
  return false;
}

/** Reason WebFetch must refuse `rawUrl` (SSRF guard), or null if it's allowed. Blocks
 *  non-http(s) schemes and hosts that RESOLVE to a private address (catches DNS names
 *  pointing inward). Set FREECODE_WEBFETCH_ALLOW_LOCAL=1 to reach your own dev servers. */
export async function ssrfGuard(rawUrl: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return "not a valid URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `scheme "${u.protocol}" is not allowed (only http/https)`;
  if (process.env.FREECODE_WEBFETCH_ALLOW_LOCAL === "1") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local)$/i.test(host)) return `"${host}" is a local host`;
  let ips: string[];
  if (isIP(host)) ips = [host];
  else {
    try { ips = (await lookup(host, { all: true })).map((a) => a.address); }
    catch { return null; } // resolution failure → let fetch surface the real error
  }
  const bad = ips.find(isPrivateIp);
  return bad ? `"${host}" resolves to a private/internal address (${bad})` : null;
}

const ArgsSchema = z.object({
  url: z.string().url().describe("Absolute URL including the scheme, e.g. https://example.com/page. A bare host or search phrase is rejected."),
  maxBytes: z.number().int().positive().max(5_000_000).describe("Cap on bytes fetched before truncating (avoids blowing the context window on huge pages).").optional(),
});

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

// Content-types WebFetch can meaningfully turn into text. Anything else (wasm,
// octet-stream, images, archives, fonts, pdf, audio/video) is binary — decoding
// it as UTF-8 produces garbage that, dumped into the prompt, can blow past the
// model's context window. A blank content-type is allowed through to the byte
// sniff below.
const TEXTUAL = /text\/|html|json|xml|javascript|ecmascript|csv|svg|application\/(rss|atom|x-www-form)/;

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd); // U+FFFD, emitted when a UTF-8 decode fails

/** Sniff a decoded string for binary content — servers mislabel types, and a
 *  .wasm served as text/plain still must not reach the prompt. A NUL byte, UTF-8
 *  replacement chars, or a high density of control bytes mean "not text". */
export function looksBinary(s: string): boolean {
  const sample = s.slice(0, 4096);
  if (!sample) return false;
  if (sample.includes(NUL)) return true;
  let suspicious = 0;
  for (const ch of sample) {
    if (ch === REPLACEMENT) { suspicious++; continue; }
    const c = ch.codePointAt(0)!;
    if (c < 9 || (c > 13 && c < 32)) suspicious++; // control chars, excluding \t\n\v\f\r
  }
  return suspicious / sample.length > 0.1;
}

/** Fetch `url`, following redirects MANUALLY so EACH hop is SSRF-checked — a public
 *  URL that 302-redirects to 169.254.169.254 or localhost can't smuggle past the
 *  guard. Bounded hop count. Returns the final Response, or a `blocked` reason. */
async function guardedFetch(url: string): Promise<Response | { blocked: string }> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const reason = await ssrfGuard(current);
    if (reason) return { blocked: `Refusing to fetch ${current}: ${reason}. WebFetch is restricted to public http(s) URLs. To reach a local/internal host, set FREECODE_WEBFETCH_ALLOW_LOCAL=1.` };
    const resp = await fetch(current, { headers: { "user-agent": "freecode/0.1" }, redirect: "manual" });
    const loc = resp.headers.get("location");
    if (resp.status >= 300 && resp.status < 400 && loc) { current = new URL(loc, current).toString(); continue; }
    return resp;
  }
  return { blocked: `Too many redirects fetching ${url}` };
}

export const WebFetchTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "WebFetch",
  description: "Fetch a URL and return its content as markdown. Reads TEXT/HTML pages only — it refuses binary files (wasm, images, archives, pdf, fonts); download those with Bash instead. Use only when the user provides or references a specific URL, or explicitly asks you to fetch a page. Do not fabricate URLs or fetch pages speculatively.",
  schema: ArgsSchema,
  permission: "confirm",
  async run(args) {
    const cap = args.maxBytes ?? 1_000_000;
    // SSRF guard: don't let a model-supplied (or injection-supplied) URL reach cloud
    // metadata, localhost, or internal/Tailscale hosts and return their response into
    // the context. Every redirect hop is re-checked, so nothing internal is contacted.
    let resp: Response;
    try {
      const r = await guardedFetch(args.url);
      if ("blocked" in r) return { ok: false, output: "", error: r.blocked };
      resp = r;
    } catch (err) {
      return { ok: false, output: "", error: `Fetch failed: ${String(err)}` };
    }
    if (!resp.ok) return { ok: false, output: "", error: `HTTP ${resp.status} for ${args.url}` };
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase();

    // Reject known-binary content by type before decoding megabytes of bytes.
    if (ct && !TEXTUAL.test(ct)) {
      const len = resp.headers.get("content-length");
      const size = len ? `${len} bytes` : "unknown size";
      return {
        ok: false,
        output: "",
        error: `${args.url} is binary content (${ct}, ${size}). WebFetch only reads text/HTML pages — to save a binary file, download it with Bash (e.g. Invoke-WebRequest -Uri … -OutFile …).`,
      };
    }

    const raw = await resp.text();
    // Backstop: even a textual/blank content-type can be a mislabeled binary.
    if (looksBinary(raw)) {
      return {
        ok: false,
        output: "",
        error: `${args.url} returned binary or non-text data (content-type "${ct || "none"}"). WebFetch only reads text; download it with Bash if you need the file.`,
      };
    }

    const text = raw.slice(0, cap);
    const isHtml = ct.includes("html") || /^\s*<(?:!doctype|html)/i.test(raw);
    if (!isHtml) {
      return { ok: true, output: text, metadata: { contentType: ct, truncated: raw.length > cap } };
    }
    const markdown = td.turndown(text);
    return { ok: true, output: markdown, metadata: { contentType: ct, bytes: markdown.length, truncated: raw.length > cap } };
  },
};
