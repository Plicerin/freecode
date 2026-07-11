// /recover reconstructs a file's earlier contents from the session log after a
// destructive edit. These tests cover the log-reconstruction (FileWrite bytes +
// complete FileReads), the de-numbering of read output, the dedup/ordering that
// surfaces distinct versions newest-first, and the non-destructive restore.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "../src/session/manager";
import { snapshotsFromEvents, dedupeSnapshots, deNumberReadOutput, writeRecovered, currentFileInfo } from "../src/session/recover";

const CWD = join(tmpdir(), "proj");
const TARGET = join(CWD, "cockpit.ts");

function call(id: string, name: string, args: Record<string, unknown>, ts: string): SessionEvent {
  return { kind: "tool_call", id, name, args, ts };
}
function result(id: string, output: string, ok: boolean, ts: string): SessionEvent {
  return { kind: "tool_result", id, output, ok, ts, durationMs: 1 };
}

describe("deNumberReadOutput", () => {
  test("strips the line-number gutter", () => {
    const { content, partial } = deNumberReadOutput("     1\tfoo\n     2\tbar");
    expect(content).toBe("foo\nbar");
    expect(partial).toBe(false);
  });
  test("flags a truncated read as partial", () => {
    const out = "     1\tfoo\n\n[showing lines 1-1 of 9000 — use offset/limit to read more]";
    const { partial } = deNumberReadOutput(out);
    expect(partial).toBe(true);
  });
});

describe("snapshotsFromEvents", () => {
  test("reconstructs the exact bytes from a FileWrite", () => {
    const events = [
      call("1", "FileWrite", { path: TARGET, content: "full\ncontent\n" }, "2026-01-01T00:00:00Z"),
      result("1", "Wrote 13 bytes", true, "2026-01-01T00:00:01Z"),
    ];
    const snaps = snapshotsFromEvents(events, CWD, "sess1", TARGET);
    expect(snaps.length).toBe(1);
    expect(snaps[0]!.content).toBe("full\ncontent\n");
    expect(snaps[0]!.source).toBe("write");
  });

  test("reconstructs from a complete FileRead (de-numbered)", () => {
    const events = [
      call("2", "FileRead", { path: TARGET }, "2026-01-02T00:00:00Z"),
      result("2", "     1\tline a\n     2\tline b", true, "2026-01-02T00:00:01Z"),
    ];
    const snaps = snapshotsFromEvents(events, CWD, "sess1", TARGET);
    expect(snaps.length).toBe(1);
    expect(snaps[0]!.content).toBe("line a\nline b");
    expect(snaps[0]!.source).toBe("read");
  });

  test("skips partial reads (paged or truncated) and failed calls", () => {
    const events = [
      call("3", "FileRead", { path: TARGET, offset: 100 }, "2026-01-03T00:00:00Z"),
      result("3", "   101\tsomething", true, "2026-01-03T00:00:01Z"),
      call("4", "FileRead", { path: TARGET }, "2026-01-03T01:00:00Z"),
      result("4", "     1\thead\n\n[showing lines 1-1 of 9000 — use offset/limit to read more]", true, "2026-01-03T01:00:01Z"),
      call("5", "FileWrite", { path: TARGET, content: "x" }, "2026-01-03T02:00:00Z"),
      result("5", "Error: disk full", false, "2026-01-03T02:00:01Z"),
    ];
    expect(snapshotsFromEvents(events, CWD, "sess1", TARGET)).toEqual([]);
  });

  test("ignores events for other files", () => {
    const events = [
      call("6", "FileWrite", { path: join(CWD, "other.ts"), content: "nope" }, "2026-01-04T00:00:00Z"),
      result("6", "Wrote", true, "2026-01-04T00:00:01Z"),
    ];
    expect(snapshotsFromEvents(events, CWD, "sess1", TARGET)).toEqual([]);
  });
});

describe("dedupeSnapshots", () => {
  test("collapses identical content to the newest sighting", () => {
    const mk = (content: string, ts: string) => snapshotsFromEvents(
      [call("a", "FileWrite", { path: TARGET, content }, ts), result("a", "ok", true, ts)],
      CWD, "s", TARGET,
    )[0]!;
    const deduped = dedupeSnapshots([
      mk("same\n", "2026-01-01T00:00:00Z"),
      mk("same\n", "2026-01-05T00:00:00Z"),
    ]);
    expect(deduped.length).toBe(1);
    expect(deduped[0]!.ts).toBe("2026-01-05T00:00:00Z");
  });

  test("the cockpit case: a newer TRUNCATED version and an older FULL one, newest-first", () => {
    const full = snapshotsFromEvents(
      [call("f", "FileRead", { path: TARGET }, "2026-01-01T00:00:00Z"),
       result("f", "     1\ta\n     2\tb\n     3\tc\n     4\td\n     5\te", true, "2026-01-01T00:00:01Z")],
      CWD, "old-session", TARGET,
    )[0]!;
    const trunc = snapshotsFromEvents(
      [call("t", "FileWrite", { path: TARGET, content: "a\nb" }, "2026-01-10T00:00:00Z"),
       result("t", "Wrote", true, "2026-01-10T00:00:01Z")],
      CWD, "crash-session", TARGET,
    )[0]!;
    const snaps = dedupeSnapshots([full, trunc]);
    expect(snaps.length).toBe(2);
    expect(snaps[0]!.lines).toBe(2); // newest first = the truncated version
    expect(snaps[1]!.lines).toBe(5); // the good full version is /recover <file> 2
    expect(snaps[1]!.content).toBe("a\nb\nc\nd\ne");
  });
});

describe("writeRecovered / currentFileInfo", () => {
  test("writes <path>.recovered and never touches the working file", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    try {
      const f = join(dir, "cockpit.ts");
      writeFileSync(f, "current damaged\n");
      const dest = writeRecovered(f, "restored good content\n");
      expect(dest).toBe(f + ".recovered");
      expect(readFileSync(dest, "utf8")).toBe("restored good content\n");
      expect(readFileSync(f, "utf8")).toBe("current damaged\n"); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("currentFileInfo reports lines/bytes, or null when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    try {
      const f = join(dir, "a.ts");
      writeFileSync(f, "one\ntwo\n");
      expect(currentFileInfo(f)).toEqual({ lines: 3, bytes: 8 });
      expect(currentFileInfo(join(dir, "missing.ts"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
