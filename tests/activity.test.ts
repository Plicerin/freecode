import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setActivityLog, logActivity, activityState } from "../src/utils/activity";

test("does not write when disabled", () => {
  const p = join(mkdtempSync(join(tmpdir(), "fc-act-")), "off.log");
  setActivityLog(false, p);
  logActivity("should not appear");
  expect(existsSync(p)).toBe(false);
});

test("appends timestamped lines when enabled, and reports its path", () => {
  const p = join(mkdtempSync(join(tmpdir(), "fc-act-")), "on.log");
  const st = setActivityLog(true, p);
  expect(st.on).toBe(true);
  expect(activityState().path).toBe(p);
  logActivity("VERIFY bun run typecheck → PASS");
  logActivity("LEDGER verified=[typecheck passed] observed=[edited a.ts] believed=[]");
  const text = readFileSync(p, "utf8");
  expect(text).toMatch(/VERIFY bun run typecheck → PASS/);
  expect(text).toMatch(/LEDGER verified=\[typecheck passed\]/);
  // each line is ISO-timestamped
  expect(text.split("\n").filter(Boolean).every((l) => /^\d{4}-\d\d-\d\dT/.test(l))).toBe(true);
  setActivityLog(false); // leave global state off for other tests
});
