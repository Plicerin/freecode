import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, isAbsolute, extname, dirname, basename } from "node:path";
import type { ImagePart } from "../providers/types";
import { closest } from "../utils/fuzzy";

/** Suggest the nearest existing filename in the same directory (typo help). */
function suggestSibling(abs: string): string | undefined {
  try {
    const names = readdirSync(dirname(abs));
    const match = closest(basename(abs), names, 4);
    return match;
  } catch {
    return undefined;
  }
}

const MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image
const MAX_TEXT_BYTES = 256 * 1024; // 256 KB per inlined text file

export interface FileAttachment {
  path: string;
  content: string;
}

/**
 * Find @path tokens that point to real files. Images become base64 ImageParts;
 * other existing files have their text contents inlined (FileAttachment).
 * Non-image @tokens that don't resolve to a file are ignored (so "@mention"
 * in prose isn't treated as an attachment). The text is returned unchanged.
 */
export function extractAttachments(
  text: string,
  cwd: string,
): { text: string; images: ImagePart[]; files: FileAttachment[]; notes: string[] } {
  const images: ImagePart[] = [];
  const files: FileAttachment[] = [];
  const notes: string[] = [];
  const tokenRe = /@(?:"([^"]+)"|([^\s"]+))/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    let p = m[1] ?? m[2];
    if (!p) continue;
    // For unquoted tokens, strip trailing punctuation so "@file.png:" or
    // "@file.png?" resolve correctly (the colon/question mark isn't part of the path).
    if (!m[1]) p = p.replace(/[)\].,:;!?'"]+$/, "");
    if (!p) continue;
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    const ext = extname(p).toLowerCase();
    const mediaType = MEDIA[ext];
    const isFile = existsSync(abs) && statSync(abs).isFile();

    if (mediaType) {
      // image attachment
      if (!isFile) {
        const hint = suggestSibling(abs);
        notes.push(`attachment not found: ${p}${hint ? ` (did you mean ${hint}?)` : ""}`);
        continue;
      }
      if (statSync(abs).size > MAX_IMAGE_BYTES) { notes.push(`image too large (>10MB): ${p}`); continue; }
      try {
        images.push({ data: readFileSync(abs).toString("base64"), mediaType });
        notes.push(`attached ${p}`);
      } catch { notes.push(`failed to read: ${p}`); }
    } else if (isFile) {
      // text-file inclusion
      if (statSync(abs).size > MAX_TEXT_BYTES) { notes.push(`file too large to inline (>256KB): ${p}`); continue; }
      try {
        const buf = readFileSync(abs);
        if (buf.subarray(0, 8192).includes(0)) { notes.push(`skipped binary file: ${p}`); continue; }
        files.push({ path: p, content: buf.toString("utf8") });
        notes.push(`included ${p}`);
      } catch { notes.push(`failed to read: ${p}`); }
    }
    // non-image token that isn't a file → ignore (likely an @mention in prose)
  }
  return { text, images, files, notes };
}
