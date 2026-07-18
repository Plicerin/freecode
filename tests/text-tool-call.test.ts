import { test, expect, describe } from "bun:test";
import { looksLikeTextToolCall } from "../src/agent/text-tool-call";

describe("looksLikeTextToolCall", () => {
  test("detects leaked tool-call markup (the lfm2/LM Studio case)", () => {
    expect(looksLikeTextToolCall("...\n<function-calls>\n<parameter name=\"runInBackground\" value=\"true\">\n</observation>")).toBe(true);
    expect(looksLikeTextToolCall("<function_calls><invoke name=\"Bash\">")).toBe(true);
    expect(looksLikeTextToolCall("<tool_call>{\"name\":\"Bash\"}</tool_call>")).toBe(true);
    expect(looksLikeTextToolCall("<function=Bash>ls</function>")).toBe(true);
  });

  test("does NOT fire on normal prose or code", () => {
    expect(looksLikeTextToolCall("I'll run the dev server for you.")).toBe(false);
    expect(looksLikeTextToolCall("const x = <T>(): void => {};")).toBe(false);
    expect(looksLikeTextToolCall("")).toBe(false);
    expect(looksLikeTextToolCall("Here's a function call in JS: foo(1, 2)")).toBe(false);
  });
});
