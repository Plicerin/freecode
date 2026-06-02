import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, isAbsolute, extname } from "node:path";
import { z } from "zod";
import type { Tool } from "./types";

const MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const ArgsSchema = z.object({
  path: z.string().min(1),
});

export const ViewImageTool: Tool<z.infer<typeof ArgsSchema>> = {
  name: "ViewImage",
  description: "Load an image file from disk so you can SEE its visual contents. Call this to examine images you find (e.g. before describing or renaming them by content). Supports png/jpg/jpeg/gif/webp.",
  schema: ArgsSchema,
  permission: "safe",
  async run(args, ctx) {
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
    const ext = extname(abs).toLowerCase();
    const mediaType = MEDIA[ext];
    if (!mediaType) {
      return { ok: false, output: "", error: `Not a supported image type: ${ext || "(none)"}. Supported: ${Object.keys(MEDIA).join(", ")}` };
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return { ok: false, output: "", error: `Image not found: ${args.path}` };
    }
    const size = statSync(abs).size;
    if (size > MAX_BYTES) {
      return { ok: false, output: "", error: `Image too large (${size} bytes; max ${MAX_BYTES})` };
    }
    let data: string;
    try {
      data = readFileSync(abs).toString("base64");
    } catch (err) {
      return { ok: false, output: "", error: `Failed to read image: ${String(err)}` };
    }
    return {
      ok: true,
      output: `Loaded ${args.path} (${mediaType}, ${size} bytes) — it is now visible to you.`,
      images: [{ data, mediaType }],
      metadata: { path: abs, mediaType, bytes: size },
    };
  },
};
