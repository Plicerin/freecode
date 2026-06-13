// A weak model can silently corrupt a structured file — duplicate a block, drop a
// comma, leave a brace open — and the first sign is a broken `npm run build`, which
// the model then misdiagnoses as "the build environment". (This happened: a primary
// agent duplicated package.json's script entries → EJSONPARSE → it blamed the env.)
// Catch it at the WRITE instead: parse JSON-family files before they land, and
// refuse a corrupting write with the exact syntax fault, so the model repairs the
// file rather than blaming its surroundings.
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

// JSONC tolerance (comments + trailing commas) so tsconfig / settings / .vscode
// files aren't false-flagged. This still catches the EJSONPARSE class — a missing
// comma, an unbalanced or DUPLICATED block, a stray token — which is the real
// corruption a build chokes on.
const JSON_LIKE = /\.(json|jsonc|json5|webmanifest)$/i;

/** If `path` is a JSON-family file whose `content` won't parse, return a precise,
 *  actionable error naming the first syntax fault and where it is; otherwise null.
 *  Writing an empty file is a legitimate intent (truncation) and is allowed. */
export function structuredWriteError(path: string, content: string): string | null {
  if (!JSON_LIKE.test(path)) return null;
  if (content.trim() === "") return null;
  const errors: ParseError[] = [];
  parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length === 0) return null;
  const e = errors[0]!;
  const before = content.slice(0, e.offset);
  const line = before.split("\n").length;
  const col = e.offset - before.lastIndexOf("\n");
  return (
    `Refusing this write: it would leave ${path} as INVALID JSON — ` +
    `${printParseErrorCode(e.error)} at line ${line}, column ${col}. ` +
    `That is almost always a missing comma, a stray or DUPLICATED block, or an unbalanced brace/bracket. ` +
    `Re-read the file to see its current contents, fix the syntax, then write again.`
  );
}
