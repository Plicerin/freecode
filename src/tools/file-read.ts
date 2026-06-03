import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
import type { Tool } from "./types";

const ArgsSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(10_000).optional(),
});

// Bounds chosen so a huge or minified file informs the model without flooding
// its context. A large file is read as a HEAD (not rejected); an over-long line
// (e.g. minified JSON/JS) is clipped; and there's a final total-output ceiling.
const READ_BYTE_CAP = 2_000_000; // never pull more than ~2MB into memory
const DEFAULT_LINE_LIMIT = 2_000; // lines returned when the caller gives none
const MAX_LINE_CHARS = 2_000; // per-line clip — the minified-file guard
const MAX_OUTPUT_CHARS = 100_000; // final safety net on total content returned

/** Read up to `max` bytes; for larger files returns a head and flags it. */
function readBounded(abs: string, size: number, max: number): { buf: Buffer; bytesTruncated: boolean } {
  if (size <= max) return { buf: readFileSync(abs), bytesTruncated: false };
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return { buf: buf.subarray(0, n), bytesTruncated: true };
  } finally {
    closeSync(fd);
  }
}

export const FileReadTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "FileRead",
  description:
    "Read a file from disk, with line numbers. Large files are read as a head; long lines (e.g. minified JSON) are clipped. Use offset/limit to page through. Binary files report an error.",
  schema: ArgsSchema,
  permission: "safe",
  async run(args, ctx) {
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
    if (!existsSync(abs)) {
      return { ok: false, output: "", error: `File not found: ${args.path}` };
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      return { ok: false, output: "", error: `Path is a directory, not a file: ${args.path}` };
    }

    let buf: Buffer;
    let bytesTruncated: boolean;
    try {
      ({ buf, bytesTruncated } = readBounded(abs, stat.size, READ_BYTE_CAP));
    } catch (err) {
      return { ok: false, output: "", error: `Failed to read: ${String(err)}` };
    }
    // Binary heuristic: a NUL byte in the first 8KB means it isn't UTF-8 text.
    if (buf.subarray(0, 8192).includes(0)) {
      return { ok: false, output: "", error: `Binary file (not UTF-8 text): ${args.path}` };
    }

    const allLines = buf.toString("utf8").split("\n");
    const start = args.offset ?? 0;
    const limit = args.limit ?? DEFAULT_LINE_LIMIT;
    const slice = allLines.slice(start, start + limit);
    const linesTruncated = start + slice.length < allLines.length;

    let perLineClipped = false;
    const numbered = slice
      .map((l, i) => {
        let shown = l;
        if (shown.length > MAX_LINE_CHARS) {
          shown = shown.slice(0, MAX_LINE_CHARS) + ` … [+${l.length - MAX_LINE_CHARS} chars]`;
          perLineClipped = true;
        }
        return `${String(start + i + 1).padStart(6, " ")}\t${shown}`;
      })
      .join("\n");

    let output = numbered;
    let outputClipped = false;
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS);
      outputClipped = true;
    }

    const notes: string[] = [];
    if (bytesTruncated) notes.push(`file is ${stat.size} bytes — read first ${READ_BYTE_CAP}`);
    if (linesTruncated) notes.push(`showing lines ${start + 1}-${start + slice.length} of ${allLines.length}`);
    if (perLineClipped) notes.push(`long lines clipped to ${MAX_LINE_CHARS} chars`);
    if (outputClipped) notes.push(`output capped at ${MAX_OUTPUT_CHARS} chars`);
    if (notes.length) output += `\n\n[${notes.join("; ")} — use offset/limit to read more]`;

    return {
      ok: true,
      output,
      metadata: {
        totalLines: allLines.length,
        bytes: stat.size,
        shown: slice.length,
        truncated: bytesTruncated || linesTruncated || perLineClipped || outputClipped,
      },
    };
  },
};
