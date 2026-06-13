// Some local servers (Ollama with certain templates) don't parse a model's tool
// call into structured tool_calls — the call leaks into content as JSON. The
// model said the right thing; the server dropped it. recoverTextToolCall pulls it
// back out so the loop can run it. Conservative: only fires when the JSON names a
// REGISTERED tool, so example/config JSON in prose is never mistaken for a call.
import { test, expect, describe } from "bun:test";
import { recoverTextToolCall } from "../src/agent/text-tool-call";

const TOOLS = ["Bash", "FileEdit", "FileRead", "Grep"];

describe("recoverTextToolCall", () => {
  test("recovers the exact failure: a Bash call emitted as text", () => {
    const text = `Now, I will run the build.\n{\n  "name": "Bash",\n  "arguments": { "command": "npm run tauri:build", "cwd": "C:/x" }\n}`;
    const r = recoverTextToolCall(text, TOOLS);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("Bash");
    expect(r!.arguments.command).toBe("npm run tauri:build");
  });

  test("ignores example/config JSON whose keys aren't a tool name", () => {
    const text = `Here's the config:\n{ "build": { "defaultWidth": 1922, "defaultHeight": 1065 } }`;
    expect(recoverTextToolCall(text, TOOLS)).toBeNull();
  });

  test("picks the tool-call object even when config JSON is also present", () => {
    const text = `I'll set it:\n{ "build": { "devPath": "/" } }\nthen run:\n{"name":"Bash","arguments":{"command":"ls"}}`;
    const r = recoverTextToolCall(text, TOOLS);
    expect(r?.name).toBe("Bash");
    expect(r?.arguments.command).toBe("ls");
  });

  test("handles a <tool_call> wrapper and a ```json fence", () => {
    const wrapped = recoverTextToolCall(`<tool_call>\n{"name":"Grep","arguments":{"pattern":"TODO"}}\n</tool_call>`, TOOLS);
    expect(wrapped?.name).toBe("Grep");
    const fenced = recoverTextToolCall("```json\n{\"name\":\"FileRead\",\"arguments\":{\"path\":\"a.ts\"}}\n```", TOOLS);
    expect(fenced?.name).toBe("FileRead");
  });

  test("accepts alias keys (tool / parameters)", () => {
    const r = recoverTextToolCall(`{"tool":"FileEdit","parameters":{"path":"a.ts","oldText":"x","newText":"y"}}`, TOOLS);
    expect(r?.name).toBe("FileEdit");
    expect(r?.arguments.path).toBe("a.ts");
  });

  test("nested braces in arguments don't break the scan", () => {
    const r = recoverTextToolCall(`{"name":"FileEdit","arguments":{"path":"p","newText":"{ \\"a\\": { \\"b\\": 1 } }"}}`, TOOLS);
    expect(r?.name).toBe("FileEdit");
  });

  test("no match → null; prose without JSON → null", () => {
    expect(recoverTextToolCall("I think the build is fine now.", TOOLS)).toBeNull();
    expect(recoverTextToolCall(`{"name":"NotATool","arguments":{}}`, TOOLS)).toBeNull();
    expect(recoverTextToolCall("", TOOLS)).toBeNull();
  });
});
