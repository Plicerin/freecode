// Models call tools by their trained names (Write/Read/Edit/shell), but freecode
// names them FileWrite/FileRead/FileEdit/Bash. resolveTool maps the common
// cross-framework aliases so the first call works instead of "tool not found".
import { test, expect, describe } from "bun:test";
import { resolveTool } from "../src/tools/resolve";
import type { Tool } from "../src/tools/types";

const t = (name: string) => ({ name } as Tool);
const TOOLS = ["FileWrite", "FileRead", "FileEdit", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "ViewImage"].map(t);
const nameOf = (name: string) => resolveTool(TOOLS, name)?.name;

describe("resolveTool", () => {
  test("exact names still resolve to themselves", () => {
    expect(nameOf("FileWrite")).toBe("FileWrite");
    expect(nameOf("Bash")).toBe("Bash");
  });

  test("the standard Claude-Code names map to freecode's tools", () => {
    expect(nameOf("Write")).toBe("FileWrite");
    expect(nameOf("Read")).toBe("FileRead");
    expect(nameOf("Edit")).toBe("FileEdit");
  });

  test("shell/editor/other framework aliases map through", () => {
    expect(nameOf("shell")).toBe("Bash");
    expect(nameOf("terminal")).toBe("Bash");
    expect(nameOf("str_replace_editor")).toBe("FileEdit");
    expect(nameOf("str_replace")).toBe("FileEdit");
    expect(nameOf("run_command")).toBe("Bash");
    expect(nameOf("find_files")).toBe("Glob");
    expect(nameOf("search_text")).toBe("Grep");
  });

  test("case-insensitive, separators tolerant", () => {
    expect(nameOf("filewrite")).toBe("FileWrite");
    expect(nameOf("BASH")).toBe("Bash");
    expect(nameOf("Write_File")).toBe("FileWrite");
  });

  test("an EXACT/real tool wins over an alias (never override a real tool)", () => {
    const withSearch = [...TOOLS, t("search")]; // a real MCP tool literally named "search"
    expect(resolveTool(withSearch, "search")?.name).toBe("search"); // not Grep
  });

  test("an alias to a tool NOT in the set resolves to undefined (e.g. Bash filtered in plan mode)", () => {
    const readOnly = ["FileRead", "Grep", "Glob"].map(t);
    expect(resolveTool(readOnly, "shell")).toBeUndefined();
    expect(resolveTool(readOnly, "Read")?.name).toBe("FileRead");
  });

  test("a genuinely unknown name is undefined", () => {
    expect(resolveTool(TOOLS, "frobnicate")).toBeUndefined();
  });
});
