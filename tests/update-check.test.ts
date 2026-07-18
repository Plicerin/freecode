// The npm-install update notifier: it must correctly tell "am I behind?", never
// nag a source checkout or an offline user, and throttle so it hits npm at most
// once a day. All deps are injectable so this runs with no network and no clock.
import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { baseVersion, isNewer, isSourceRun, checkForUpdate } from "../src/agent/update-check";

describe("baseVersion strips build/pre-release suffixes", () => {
  test("plain, +sha, -dev, -dev+sha, v-prefix all reduce to x.y.z", () => {
    expect(baseVersion("0.1.3")).toBe("0.1.3");
    expect(baseVersion("0.1.3+94933e4")).toBe("0.1.3");
    expect(baseVersion("0.1.3-dev+abc1234")).toBe("0.1.3");
    expect(baseVersion("v2.5.9")).toBe("2.5.9");
  });
});

describe("isNewer compares x.y.z, ignoring suffixes", () => {
  test("patch/minor/major increments are newer", () => {
    expect(isNewer("0.1.3", "0.1.2")).toBe(true);
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });
  test("equal or older is not newer", () => {
    expect(isNewer("0.1.2", "0.1.2")).toBe(false);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
  });
  test("suffixes don't affect the comparison", () => {
    expect(isNewer("0.1.3+sha", "0.1.2-dev+x")).toBe(true);
    expect(isNewer("0.1.2+a", "0.1.2+b")).toBe(false);
  });
  test("un-parseable input never claims newer", () => {
    expect(isNewer("garbage", "0.1.2")).toBe(false);
    expect(isNewer("0.1.3", "not-a-version")).toBe(false);
  });
});

describe("isSourceRun detects the -dev tag", () => {
  test("source runs carry -dev; npm builds don't", () => {
    expect(isSourceRun("0.1.3-dev+abc")).toBe(true);
    expect(isSourceRun("0.1.3+abc")).toBe(false);
    expect(isSourceRun("0.1.3")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  const stamps: string[] = [];
  const tmpStamp = (): string => { const p = join(tmpdir(), `fc-update-${Math.random().toString(36).slice(2)}.json`); stamps.push(p); return p; };
  afterEach(() => { for (const p of stamps.splice(0)) { try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } } });

  test("returns the newer version and writes the stamp when forced", async () => {
    const stampPath = tmpStamp();
    const got = await checkForUpdate({ version: "0.1.2+sha", stampPath, force: true, now: 1000, fetchLatest: async () => "0.1.3" });
    expect(got).toBe("0.1.3");
    expect(JSON.parse(readFileSync(stampPath, "utf8"))).toEqual({ checkedAt: 1000, latest: "0.1.3" });
  });

  test("returns null when already current", async () => {
    const got = await checkForUpdate({ version: "0.1.3+sha", stampPath: tmpStamp(), force: true, fetchLatest: async () => "0.1.3" });
    expect(got).toBeNull();
  });

  test("a source run never checks (no fetch, no nag)", async () => {
    let fetched = false;
    const got = await checkForUpdate({ version: "0.1.2-dev+sha", stampPath: tmpStamp(), force: true, fetchLatest: async () => { fetched = true; return "0.1.3"; } });
    expect(got).toBeNull();
    expect(fetched).toBe(false);
  });

  test("FREECODE_NO_UPDATE_CHECK=1 opts out entirely", async () => {
    let fetched = false;
    const got = await checkForUpdate({ version: "0.1.2+sha", stampPath: tmpStamp(), force: true, env: { FREECODE_NO_UPDATE_CHECK: "1" }, fetchLatest: async () => { fetched = true; return "0.1.3"; } });
    expect(got).toBeNull();
    expect(fetched).toBe(false);
  });

  test("within the throttle window it uses the cached value — no network", async () => {
    const stampPath = tmpStamp();
    // seed the stamp as if checked 1h ago with latest 0.1.5
    await checkForUpdate({ version: "0.1.2+sha", stampPath, now: 0, force: true, fetchLatest: async () => "0.1.5" });
    let refetched = false;
    const got = await checkForUpdate({ version: "0.1.2+sha", stampPath, now: 60 * 60 * 1000, env: {}, fetchLatest: async () => { refetched = true; return "0.9.9"; } });
    expect(refetched).toBe(false);   // within 24h → cached
    expect(got).toBe("0.1.5");       // the cached latest, not the (unused) 0.9.9
  });

  test("re-fetches after the window elapses", async () => {
    const stampPath = tmpStamp();
    await checkForUpdate({ version: "0.1.2+sha", stampPath, now: 0, force: true, fetchLatest: async () => "0.1.5" });
    let refetched = false;
    const got = await checkForUpdate({ version: "0.1.2+sha", stampPath, now: 25 * 60 * 60 * 1000, env: {}, fetchLatest: async () => { refetched = true; return "0.1.7"; } });
    expect(refetched).toBe(true);    // > 24h → fresh fetch
    expect(got).toBe("0.1.7");
  });

  test("a failed fetch with no cache stays silent (null)", async () => {
    const got = await checkForUpdate({ version: "0.1.2+sha", stampPath: tmpStamp(), force: true, env: {}, fetchLatest: async () => null });
    expect(got).toBeNull();
  });
});
