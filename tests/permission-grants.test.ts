// Per-project persistence of "allow always" grants: survives a relaunch, keyed
// by folder, and NEVER remembers Bash (command execution stays per-session).
import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGrants, persistGrant, makeGrantStore, isPersistableTool } from "../src/config/permission-grants";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "oc-grants-")), "permissions.json");
}

describe("permission-grants persistence", () => {
  test("persists and reads back a grant for a folder", () => {
    const p = tmpFile();
    const cwd = "C:\\proj\\dracula";
    expect(readGrants(cwd, p)).toEqual([]);
    persistGrant(cwd, "FileWrite", p);
    persistGrant(cwd, "FileEdit", p);
    expect(readGrants(cwd, p).sort()).toEqual(["FileEdit", "FileWrite"]);
  });

  test("grants are per-folder — another folder starts empty", () => {
    const p = tmpFile();
    persistGrant("C:\\proj\\a", "FileWrite", p);
    expect(readGrants("C:\\proj\\a", p)).toEqual(["FileWrite"]);
    expect(readGrants("C:\\proj\\b", p)).toEqual([]);
  });

  test("Bash is NEVER persisted (command execution re-confirms each session)", () => {
    const p = tmpFile();
    const cwd = "C:\\proj\\x";
    persistGrant(cwd, "Bash", p);
    expect(readGrants(cwd, p)).toEqual([]); // not written
    expect(isPersistableTool("Bash")).toBe(false);
    expect(isPersistableTool("FileWrite")).toBe(true);
  });

  test("a hand-added Bash entry is filtered on READ too (defence in depth)", () => {
    const p = tmpFile();
    const cwd = "C:\\proj\\y";
    // Simulate a manually-edited file smuggling Bash in.
    require("node:fs").writeFileSync(p, JSON.stringify({ byCwd: { [cwd]: ["Bash", "FileWrite"] } }));
    expect(readGrants(cwd, p)).toEqual(["FileWrite"]); // Bash dropped on read
  });

  test("duplicate persist is idempotent", () => {
    const p = tmpFile();
    const cwd = "C:\\proj\\z";
    persistGrant(cwd, "FileWrite", p);
    persistGrant(cwd, "FileWrite", p);
    expect(readGrants(cwd, p)).toEqual(["FileWrite"]);
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
