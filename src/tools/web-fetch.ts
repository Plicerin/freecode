import TurndownService from "turndown";
import { z } from "zod";
import type { Tool } from "./types";

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

export const WebFetchTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "WebFetch",
  description: "Fetch a URL and return its content as markdown. Reads TEXT/HTML pages only — it refuses binary files (wasm, images, archives, pdf, fonts); download those with Bash instead. Use only when the user provides or references a specific URL, or explicitly asks you to fetch a page. Do not fabricate URLs or fetch pages speculatively.",
  schema: ArgsSchema,
  permission: "confirm",
  async run(args) {
    const cap = args.maxBytes ?? 1_000_000;
    let resp: Response;
    try {
      resp = await fetch(args.url, { headers: { "user-agent": "freecode/0.1" } });
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
