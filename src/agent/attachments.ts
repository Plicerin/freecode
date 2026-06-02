import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, isAbsolute, extname } from "node:path";
import type { ImagePart } from "../providers/types";

const MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per image

/**
 * Find @path tokens in the user's text that point to image files, read and
 * base64-encode them into ImageParts. Supports @path and @"quoted path".
 * The original text is returned unchanged (the reference stays as context).
 */
export function extractAttachments(text: string, cwd: string): { text: string; images: ImagePart[]; notes: string[] } {
  const images: ImagePart[] = [];
  const notes: string[] = [];
  const tokenRe = /@(?:"([^"]+)"|([^\s"]+))/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const p = m[1] ?? m[2];
    if (!p) continue;
    const ext = extname(p).toLowerCase();
    const mediaType = MEDIA[ext];
    if (!mediaType) continue; // only image attachments
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      notes.push(`attachment not found: ${p}`);
      continue;
    }
    if (statSync(abs).size > MAX_BYTES) {
      notes.push(`attachment too large (>10MB): ${p}`);
      continue;
    }
    try {
      images.push({ data: readFileSync(abs).toString("base64"), mediaType });
      notes.push(`attached ${p}`);
    } catch {
      notes.push(`failed to read: ${p}`);
    }
  }
  return { text, images, notes };
}
