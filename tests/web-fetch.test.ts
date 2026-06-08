// WebFetch must read text/HTML but REFUSE binary — a .wasm decoded as UTF-8 and
// dumped into the prompt is what overflowed the context window (→ provider sent
// a negative max_tokens and 400'd). Two guards: content-type, and a byte sniff
// for mislabeled binaries.
import { test, expect, describe, afterEach } from "bun:test";
import { looksBinary, WebFetchTool } from "../src/tools/web-fetch";

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe("looksBinary", () => {
  test("plain text, code, and markdown are not binary", () => {
    expect(looksBinary("Hello, world. This is a normal page.")).toBe(false);
    expect(looksBinary("# Title\n\n```js\nconst x = 1;\n```\n")).toBe(false);
    expect(looksBinary("")).toBe(false);
    expect(looksBinary("tabs\tand\nnewlines\r\nare fine")).toBe(false);
  });

  test("a NUL byte means binary immediately", () => {
    expect(looksBinary("asm" + NUL + NUL + "stuff")).toBe(true);
  });

  test("a high density of replacement / control chars means binary", () => {
    const garbage = (REPLACEMENT + String.fromCharCode(1) + String.fromCharCode(2)).repeat(200);
    expect(looksBinary(garbage)).toBe(true);
  });

  test("an occasional odd char in mostly-text stays text", () => {
    const mostlyText = "normal readable content ".repeat(50) + REPLACEMENT;
    expect(looksBinary(mostlyText)).toBe(false);
  });
});

describe("WebFetchTool", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const stub = (body: string, contentType: string, extra: Record<string, string> = {}) => {
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { "content-type": contentType, ...extra } })) as unknown as typeof fetch;
  };

  test("refuses a binary content-type (e.g. application/wasm) without dumping bytes", async () => {
    stub("ignored", "application/wasm", { "content-length": "1245184" });
    const r = await WebFetchTool.run({ url: "https://example.com/jzintv.wasm" } as never, { cwd: ".", signal: undefined as never });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/binary content/i);
    expect(r.error).toMatch(/1245184 bytes/);
    expect(r.output).toBe("");
  });

  test("refuses a binary mislabeled as text/plain (byte-sniff backstop)", async () => {
    stub("ELF" + NUL + NUL + NUL + "".repeat(100), "text/plain");
    const r = await WebFetchTool.run({ url: "https://example.com/a.bin" } as never, { cwd: ".", signal: undefined as never });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/binary or non-text/i);
  });

  test("reads an HTML page and returns markdown", async () => {
    stub("<html><body><h1>Hi</h1><p>Para</p></body></html>", "text/html; charset=utf-8");
    const r = await WebFetchTool.run({ url: "https://example.com/" } as never, { cwd: ".", signal: undefined as never });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/# Hi/);
    expect(r.output).toMatch(/Para/);
  });

  test("returns plain text as-is for a text content-type", async () => {
    stub("just some plain text", "text/plain");
    const r = await WebFetchTool.run({ url: "https://example.com/readme.txt" } as never, { cwd: ".", signal: undefined as never });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("just some plain text");
  });
});
