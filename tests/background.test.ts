// Background jobs (ROADMAP Tier A). The registry is one-file-per-job so a
// detached worker writing its status never races the parent listing jobs; these
// tests pin round-trip, ordering, and the reaping that reconciles a job whose
// process died without recording a result. All use a temp root — never ~/.freecode.
import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { saveJob, readJob, listJobs, updateJob, reapJobs, isPidAlive, logFile, type BgJob } from "../src/background/registry";
import { selfInvocation, runBackgroundJob } from "../src/background/runner";
import { formatJobLine } from "../src/commands/background-cli";

function job(id: string, over: Partial<BgJob> = {}): BgJob {
  return {
    id, prompt: `do ${id}`, cwd: "/x", provider: "mock", model: "m",
    status: "running", startedAt: new Date(Date.now() - 1000).toISOString(),
    logPath: `/x/${id}.log`, ...over,
  };
}

describe("registry", () => {
  test("save / read round-trips a job", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-bg-"));
    saveJob(job("a", { pid: 123 }), root);
    const got = readJob("a", root);
    expect(got?.prompt).toBe("do a");
    expect(got?.pid).toBe(123);
    expect(readJob("missing", root)).toBeUndefined();
  });

  test("listJobs returns newest first", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-bg-"));
    saveJob(job("old", { startedAt: "2026-06-05T10:00:00.000Z" }), root);
    saveJob(job("new", { startedAt: "2026-06-05T12:00:00.000Z" }), root);
    expect(listJobs(root).map((j) => j.id)).toEqual(["new", "old"]);
  });

  test("updateJob patches and persists", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-bg-"));
    saveJob(job("a"), root);
    updateJob("a", { status: "done", exitCode: 0, summary: "all good" }, root);
    const got = readJob("a", root);
    expect(got?.status).toBe("done");
    expect(got?.summary).toBe("all good");
  });
});

describe("reaping", () => {
  test("a running job whose process is gone is marked failed", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-bg-"));
    saveJob(job("dead", { pid: 4242 }), root);
    const reaped = reapJobs(root, () => false); // pretend the pid is gone
    expect(reaped.find((j) => j.id === "dead")!.status).toBe("failed");
    expect(readJob("dead", root)!.finishedAt).toBeDefined();
  });

  test("a running job with a live process is left alone", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-bg-"));
    saveJob(job("live", { pid: 4242 }), root);
    reapJobs(root, () => true);
    expect(readJob("live", root)!.status).toBe("running");
  });

  test("an already-finished job is never touched by reaping", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-bg-"));
    saveJob(job("done", { status: "done", finishedAt: "2026-06-05T10:00:00.000Z" }), root);
    reapJobs(root, () => false);
    expect(readJob("done", root)!.status).toBe("done");
  });

  test("isPidAlive is true for this very process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe("cli helpers", () => {
  test("selfInvocation re-runs the current script when argv[1] is a real file", () => {
    const inv = selfInvocation(["bg-exec", "abc"]);
    expect(inv.cmd).toBe(process.execPath);
    // In the test runner argv[1] is a real path, so it's included before our args.
    expect(inv.args.slice(-2)).toEqual(["bg-exec", "abc"]);
  });

  test("formatJobLine shows a status icon and the prompt preview", () => {
    const line = formatJobLine(job("xyz", { status: "done", finishedAt: new Date().toISOString() }));
    expect(line).toContain("✓");
    expect(line).toContain("xyz");
    expect(line).toContain("do xyz");
  });
});

describe("worker lifecycle (in-process, mock provider)", () => {
  test("runBackgroundJob runs to completion, writes a log, and records done", async () => {
    const root = mkdtempSync(join(tmpdir(), "fc-bg-"));
    const id = "wkr";
    saveJob(job(id, { provider: "mock", model: "mock-1", logPath: logFile(id, root) }), root);
    await runBackgroundJob(id, root);
    const done = readJob(id, root)!;
    expect(done.status).toBe("done");
    expect(done.exitCode).toBe(0);
    expect(done.finishedAt).toBeDefined();
    expect(existsSync(done.logPath)).toBe(true);
    expect(readFileSync(done.logPath, "utf8")).toContain("bg job wkr started");
  });
});
