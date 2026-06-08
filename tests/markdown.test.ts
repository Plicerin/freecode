import { test, expect, describe } from "bun:test";
import { parseBlocks, tokenize, parseInline, classifyLine } from "../src/tui/markdown";

test("parseBlocks splits prose and fenced code with a language tag", () => {
  const md = "Here you go:\n```ts\nconst x = 1;\n```\nDone.";
  const b = parseBlocks(md);
  expect(b.map((x) => x.type)).toEqual(["text", "code", "text"]);
  expect(b[1]!.lang).toBe("ts");
  expect(b[1]!.content).toBe("const x = 1;");
  expect(b[0]!.content).toBe("Here you go:");
});

test("parseBlocks handles an unclosed fence (mid-stream)", () => {
  const b = parseBlocks("text\n```js\nconsole.log(1)");
  expect(b[1]!.type).toBe("code");
  expect(b[1]!.content).toBe("console.log(1)");
});

test("tokenize classifies keywords, strings, comments, numbers", () => {
  const toks = tokenize("const greeting = 'hi'; // a comment\nlet n = 42;");
  const kindOf = (text: string) => toks.find((t) => t.text === text)?.kind;
  expect(kindOf("const")).toBe("kw");
  expect(kindOf("let")).toBe("kw");
  expect(kindOf("'hi'")).toBe("str");
  expect(kindOf("42")).toBe("num");
  expect(toks.some((t) => t.kind === "com" && t.text.includes("a comment"))).toBe(true);
  expect(kindOf("greeting")).toBe("txt"); // identifier, not a keyword
});

test("tokenize handles block comments and reconstructs the source exactly", () => {
  const src = "x = /* note */ 1\ndef f(): pass";
  const toks = tokenize(src);
  expect(toks.map((t) => t.text).join("")).toBe(src); // lossless
  expect(toks.some((t) => t.kind === "com" && t.text === "/* note */")).toBe(true);
  expect(toks.find((t) => t.text === "def")?.kind).toBe("kw");
});

describe("parseInline", () => {
  const kinds = (s: string) => parseInline(s).map((x) => `${x.kind}:${x.text}`);

  test("bold, italic, and code spans (markers stripped)", () => {
    expect(kinds("a **b** c")).toEqual(["text:a ", "bold:b", "text: c"]);
    expect(kinds("a *b* c")).toEqual(["text:a ", "italic:b", "text: c"]);
    expect(kinds("use `npm run` now")).toEqual(["text:use ", "code:npm run", "text: now"]);
  });

  test("bold beats italic for ** (longest marker wins)", () => {
    expect(kinds("**strong**")).toEqual(["bold:strong"]);
  });

  test("does NOT emphasize snake_case, dunders, or spaced asterisks", () => {
    expect(kinds("do_something and __init__")).toEqual(["text:do_something and __init__"]);
    expect(kinds("5 * 3 = 15")).toEqual(["text:5 * 3 = 15"]); // spaced * stays literal
  });

  test("plain text passes through untouched", () => {
    expect(kinds("just words")).toEqual(["text:just words"]);
  });
});

describe("classifyLine", () => {
  test("headings carry their level and strip the hashes", () => {
    expect(classifyLine("# Title")).toMatchObject({ kind: "heading", level: 1, content: "Title" });
    expect(classifyLine("### Sub")).toMatchObject({ kind: "heading", level: 3, content: "Sub" });
  });
  test("bullets (-, *, +) and ordered items, with nesting indent", () => {
    expect(classifyLine("- one")).toMatchObject({ kind: "bullet", content: "one", indent: 0 });
    expect(classifyLine("    - nested")).toMatchObject({ kind: "bullet", content: "nested", indent: 2 });
    expect(classifyLine("3. third")).toMatchObject({ kind: "ordered", marker: "3", content: "third" });
  });
  test("a bare * with no following space is NOT a bullet (leaves it for inline italic)", () => {
    expect(classifyLine("*italic*").kind).toBe("plain");
  });
  test("plain prose stays plain", () => {
    expect(classifyLine("hello world")).toMatchObject({ kind: "plain", content: "hello world" });
  });
});
