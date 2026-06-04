import { test, expect } from "bun:test";
import { parseBlocks, tokenize } from "../src/tui/markdown";

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
