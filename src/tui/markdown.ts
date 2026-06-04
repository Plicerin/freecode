// Minimal, dependency-free markdown + code tokenizer for the terminal. Splits
// an assistant message into prose and fenced code blocks, and tokenizes code
// into coarse classes (keyword/string/comment/number/plain) so the renderer can
// colour them. Not a full language grammar — a pragmatic, language-agnostic
// pass that covers the common cases well enough to stop code being flat white.

export interface Block {
  type: "text" | "code";
  lang?: string;
  content: string;
}

/** Split text into prose and ``` fenced code blocks (handles an unclosed fence,
 *  which happens mid-stream). */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) blocks.push({ type: "text", content: buf.join("\n") });
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    const fence = /^\s*```(\w*)/.exec(lines[i]!);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        code.push(lines[i]!);
        i++;
      }
      i++; // skip the closing fence (no-op if we hit EOF on an open fence)
      blocks.push({ type: "code", lang: fence[1] || undefined, content: code.join("\n") });
    } else {
      buf.push(lines[i]!);
      i++;
    }
  }
  flush();
  return blocks;
}

export type Kind = "kw" | "str" | "com" | "num" | "txt";
export interface Token {
  text: string;
  kind: Kind;
}

// A broad keyword set spanning JS/TS, Python, Go, Rust, C-likes — enough to
// light up most snippets a coding agent emits.
const KEYWORDS = new Set([
  "function", "const", "let", "var", "if", "else", "elif", "for", "while", "do", "return", "yield",
  "import", "export", "from", "as", "default", "class", "extends", "implements", "interface", "enum",
  "type", "struct", "new", "delete", "typeof", "instanceof", "in", "of", "async", "await", "try",
  "catch", "finally", "throw", "switch", "case", "break", "continue", "def", "lambda", "pass", "with",
  "public", "private", "protected", "static", "void", "this", "self", "super", "fn", "pub", "mut", "use",
  "mod", "impl", "trait", "match", "func", "package", "go", "defer", "chan", "map", "range", "select",
  "true", "false", "null", "undefined", "None", "True", "False", "nil", "and", "or", "not",
]);

/** Single-pass scan into coloured tokens. Newlines/whitespace are preserved as
 *  plain tokens so the rendered block keeps its layout. */
export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const push = (text: string, kind: Kind) => { if (text) tokens.push({ text, kind }); };
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i]!;
    const next = code[i + 1];
    // line comments: // and #
    if ((c === "/" && next === "/") || c === "#") {
      let j = i;
      while (j < n && code[j] !== "\n") j++;
      push(code.slice(i, j), "com");
      i = j;
    } else if (c === "/" && next === "*") {
      // block comment
      let j = i + 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      push(code.slice(i, j), "com");
      i = j;
    } else if (c === '"' || c === "'" || c === "`") {
      // string (with escapes)
      let j = i + 1;
      while (j < n && code[j] !== c) {
        if (code[j] === "\\") j++;
        j++;
      }
      j = Math.min(n, j + 1);
      push(code.slice(i, j), "str");
      i = j;
    } else if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && /[0-9._xXa-fA-F]/.test(code[j]!)) j++;
      push(code.slice(i, j), "num");
      i = j;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(code[j]!)) j++;
      const word = code.slice(i, j);
      push(word, KEYWORDS.has(word) ? "kw" : "txt");
      i = j;
    } else {
      // operators / punctuation / whitespace
      let j = i;
      while (j < n && !/[/#"'`0-9A-Za-z_$]/.test(code[j]!)) j++;
      if (j === i) j++;
      push(code.slice(i, j), "txt");
      i = j;
    }
  }
  return tokens;
}
