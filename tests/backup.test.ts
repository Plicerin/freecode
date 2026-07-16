// The shadow-backup safety net: before any tool overwrites a file, its current
// bytes are copied aside so a destructive edit (the cockpit.ts truncation that
// motivated this) is recoverable. These tests pin the snapshot behaviour and the
// Bash write-target parser that lets us guard raw `node -e "…writeFileSync…"`.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { snapshotFile, listBackups, extractBashWriteTargets, snapshotBeforeToolRun } from "../src/tools/backup";

let root: string;
let store: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bk-"));
  store = mkdtempSync(join(tmpdir(), "bkstore-"));
  process.env.FREECODE_BACKUPS_DIR = store; // hermetic: keep out of ~/.freecode
});
afterEach(() => {
  delete process.env.FREECODE_BACKUPS_DIR;
  for (const d of [root, store]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe("snapshotFile", () => {
  test("backs up a file's current bytes", () => {
    const f = join(root, "a.ts");
    writeFileSync(f, "original\n");
    const bak = snapshotFile(f);
    expect(bak).toBeTruthy();
    expect(readFileSync(bak!, "utf8")).toBe("original\n");
    expect(listBackups(f).length).toBe(1);
  });

  test("is a no-op when content is unchanged (dedup)", () => {
    const f = join(root, "a.ts");
    writeFileSync(f, "same\n");
    expect(snapshotFile(f)).toBeTruthy();
    expect(snapshotFile(f)).toBeNull(); // identical to last snapshot
    expect(listBackups(f).length).toBe(1);
  });

  test("keeps the OLD bytes when the file changes (this is the recovery path)", () => {
    const f = join(root, "a.ts");
    writeFileSync(f, "v1-full-contents\n");
    snapshotFile(f);
    writeFileSync(f, "v2\n"); // e.g. a truncating write
    snapshotFile(f);
    const baks = listBackups(f);
    expect(baks.length).toBe(2);
    // The oldest backup still holds v1 — what we'd restore.
    expect(readFileSync(baks[0]!.path, "utf8")).toBe("v1-full-contents\n");
  });

  test("returns null for a missing file, empty file, or binary", () => {
    expect(snapshotFile(join(root, "nope.ts"))).toBeNull();
    const empty = join(root, "empty.ts"); writeFileSync(empty, "");
    expect(snapshotFile(empty)).toBeNull();
    const bin = join(root, "bin"); writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02]));
    expect(snapshotFile(bin)).toBeNull();
  });

  test("never shadow-copies a secret file (no plaintext keys in the backup store)", () => {
    for (const name of [".env", ".env.local", "id_rsa", "server.pem", "app.key", "credentials.json", "secrets.yml"]) {
      const f = join(root, name);
      writeFileSync(f, "OPENAI_API_KEY=xxxxxxxxxxxxxxxxxxxx\n");
      expect(snapshotFile(f)).toBeNull();
      expect(listBackups(f).length).toBe(0);
    }
  });
});

describe("extractBashWriteTargets", () => {
  test("finds a node fs.writeFileSync target (the truncation mechanism)", () => {
    const cmd = `node -e "const fs=require('fs');let c=fs.readFileSync('src/cockpit.ts','utf8').split('\\n');c.splice(1021);fs.writeFileSync('src/cockpit.ts',c.join('\\n'));"`;
    expect(extractBashWriteTargets(cmd, root)).toEqual([resolve(root, "src/cockpit.ts")]);
  });

  test("finds shell redirect targets but ignores fd redirects and $null", () => {
    expect(extractBashWriteTargets("echo hi > out.txt", root)).toEqual([resolve(root, "out.txt")]);
    expect(extractBashWriteTargets("tsc 2>&1 | Select-String err", root)).toEqual([]);
    expect(extractBashWriteTargets("cmd >$null", root)).toEqual([]);
  });

  test("finds PowerShell write cmdlet targets", () => {
    expect(extractBashWriteTargets("Set-Content -Path config.json -Value x", root)).toEqual([resolve(root, "config.json")]);
    expect(extractBashWriteTargets("'x' | Out-File notes.md", root)).toEqual([resolve(root, "notes.md")]);
  });

  test("skips unresolvable targets (variables, globs)", () => {
    expect(extractBashWriteTargets("echo x > $env:TEMP\\a.txt", root)).toEqual([]);
    expect(extractBashWriteTargets("rm *.tmp > log", root)).toContain(resolve(root, "log"));
  });
});

describe("snapshotBeforeToolRun", () => {
  test("snapshots the FileWrite/FileEdit target path", () => {
    const f = join(root, "edit-me.ts");
    writeFileSync(f, "before\n");
    const done = snapshotBeforeToolRun("FileWrite", { path: f, content: "after" }, root);
    expect(done).toEqual([f]);
    expect(readFileSync(listBackups(f)[0]!.path, "utf8")).toBe("before\n");
  });

  test("snapshots a file a Bash node -e write is about to clobber", () => {
    const f = join(root, "cockpit.ts");
    writeFileSync(f, "line1\nline2\nline3\n");
    const cmd = `node -e "require('fs').writeFileSync('cockpit.ts','')"`;
    const done = snapshotBeforeToolRun("Bash", { command: cmd, cwd: root }, root);
    expect(done).toEqual([f]);
    expect(readFileSync(listBackups(f)[0]!.path, "utf8")).toBe("line1\nline2\nline3\n");
  });

  test("does nothing for a read-only Bash command", () => {
    expect(snapshotBeforeToolRun("Bash", { command: "npx tsc --noEmit", cwd: root }, root)).toEqual([]);
  });

  test("backs up a FileEdit whose path lives only in the unified-diff header", () => {
    const f = join(root, "app.ts");
    writeFileSync(f, "const x = 1;\n");
    const diff = `--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n`;
    const done = snapshotBeforeToolRun("FileEdit", { unifiedDiff: diff }, root); // no `path` arg
    expect(done).toEqual([f]);
    expect(readFileSync(listBackups(f)[0]!.path, "utf8")).toBe("const x = 1;\n");
  });
});
