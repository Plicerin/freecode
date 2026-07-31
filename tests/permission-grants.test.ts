// Per-project persistence of "allow always" grants: survives a relaunch, keyed
// by folder, and remembers only intrinsically read-only built-ins.
import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGrants, persistGrant, makeGrantStore, isPersistableTool } from "../src/config/permission-grants";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "oc-grants-")), "permissions.json");
}

describe("permission-grants persistence", () => {
  test("persists and reads back read-only grants for a folder", () => {
    const p = tmpFile();
    const cwd = "C:\\proj\\dracula";
    expect(readGrants(cwd, p)).toEqual([]);
    persistGrant(cwd, "FileRead", p);
    persistGrant(cwd, "WebFetch", p);
    expect(readGrants(cwd, p).sort()).toEqual(["FileRead", "WebFetch"]);
  });

  test("grants are per-folder — another folder starts empty", () => {
    const p = tmpFile();
    persistGrant("C:\\proj\\a", "FileRead", p);
    expect(readGrants("C:\\proj\\a", p)).toEqual(["FileRead"]);
    expect(readGrants("C:\\proj\\b", p)).toEqual([]);
  });

  test("mutating and external tools are NEVER persisted", () => {
    const p = tmpFile();
    const cwd = "C:\\proj\\x";
    persistGrant(cwd, "Bash", p);
    persistGrant(cwd, "FileWrite", p);
    persistGrant(cwd, "FileEdit", p);
    persistGrant(cwd, "github__create_issue", p);
    expect(readGrants(cwd, p)).toEqual([]); // not written
    expect(isPersistableTool("Bash")).toBe(false);
    expect(isPersistableTool("FileWrite")).toBe(false);
    expect(isPersistableTool("FileRead")).toBe(true);
  });

  test("a hand-added Bash entry is filtered on READ too (defence in depth)", () => {
    const p = tmpFile();
    const cwd = "C:\\proj\\y";
    // Simulate a manually-edited file smuggling Bash in.
    require("node:fs").writeFileSync(p, JSON.stringify({ byCwd: { [cwd]: ["Bash", "FileWrite", "FileRead"] } }));
    expect(readGrants(cwd, p)).toEqual(["FileRead"]); // dangerous entries dropped on read
  });

  test("duplicate persist is idempotent", () => {
    const p = tmpFile();
    const cwd = "C:\\proj\\z";
    persistGrant(cwd, "FileRead", p);
    persistGrant(cwd, "FileRead", p);
    expect(readGrants(cwd, p)).toEqual(["FileRead"]);
  });

  test("makeGrantStore binds a folder to load/persist", () => {
    const p = tmpFile();
    const store = makeGrantStore("C:\\proj\\store", p);
    expect(store.load()).toEqual([]);
    store.persist("WebFetch");
    store.persist("Bash"); // ignored
    expect(store.load()).toEqual(["WebFetch"]);
  });
});
