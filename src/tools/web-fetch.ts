import TurndownService from "turndown";
import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  url: z.string().url(),
  maxBytes: z.number().int().positive().max(5_000_000).optional(),
});

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export const WebFetchTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "WebFetch",
  description: "Fetch a URL and return its content as markdown. Use only when the user provides or references a specific URL, or explicitly asks you to fetch a page. Do not fabricate URLs or fetch pages speculatively.",
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
    const ct = resp.headers.get("content-type") ?? "";
    const text = ct.includes("html") ? await resp.text() : await resp.text();
    const html = text.slice(0, cap);
    if (!ct.includes("html")) {
      return { ok: true, output: html, metadata: { contentType: ct, truncated: text.length > cap } };
    }
    const markdown = td.turndown(html);
    return { ok: true, output: markdown, metadata: { contentType: ct, bytes: markdown.length, truncated: text.length > cap } };
  },
};
